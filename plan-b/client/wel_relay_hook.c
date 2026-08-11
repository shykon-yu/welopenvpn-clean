#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <psapi.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>

/* WLC1 is intentionally a localhost-only protocol. It is not sent to the
 * public relay and contains no credentials. */
#define WEL_LOCAL_HEADER_LENGTH 28
/* The public WLB1 header is 48 bytes, so this payload always fits in one
 * IPv4 UDP datagram after relay encapsulation. */
#define WEL_MAX_DATAGRAM 65459
#define WEL_QUEUE_LENGTH 128
#define WEL_DISCOVERY_PORT 5739

#define WEL_LOCAL_HELLO 1
#define WEL_LOCAL_BROADCAST 2
#define WEL_LOCAL_UNICAST 3
#define WEL_LOCAL_DELIVERY 4

typedef int (WSAAPI *wel_sendto_fn)(SOCKET, const char *, int, int, const struct sockaddr *, int);
typedef int (WSAAPI *wel_recvfrom_fn)(SOCKET, char *, int, int, struct sockaddr *, int *);
typedef int (WSAAPI *wel_wsasendto_fn)(SOCKET, LPWSABUF, DWORD, LPDWORD, DWORD, const struct sockaddr *, int, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);
typedef int (WSAAPI *wel_wsarecvfrom_fn)(SOCKET, LPWSABUF, DWORD, LPDWORD, LPDWORD, struct sockaddr *, LPINT, LPWSAOVERLAPPED, LPWSAOVERLAPPED_COMPLETION_ROUTINE);

typedef struct {
    char *payload;
    int length;
    unsigned short destination_port;
    unsigned short source_port;
    IN_ADDR source_address;
} wel_delivery;

static HMODULE g_hook_module = NULL;
static volatile LONG g_stopping = 0;
static SOCKET g_bridge_socket = INVALID_SOCKET;
static wel_sendto_fn g_real_sendto = NULL;
static wel_recvfrom_fn g_real_recvfrom = NULL;
static wel_wsasendto_fn g_real_wsasendto = NULL;
static wel_wsarecvfrom_fn g_real_wsarecvfrom = NULL;
static CRITICAL_SECTION g_queue_lock;
static wel_delivery g_deliveries[WEL_QUEUE_LENGTH];

static unsigned short read_u16be(const unsigned char *value) {
    return (unsigned short)(((unsigned short)value[0] << 8) | value[1]);
}

static uint32_t read_u32be(const unsigned char *value) {
    return ((uint32_t)value[0] << 24) | ((uint32_t)value[1] << 16) |
        ((uint32_t)value[2] << 8) | (uint32_t)value[3];
}

static void write_u16be(unsigned char *value, unsigned short number) {
    value[0] = (unsigned char)(number >> 8);
    value[1] = (unsigned char)number;
}

static void write_u32be(unsigned char *value, uint32_t number) {
    value[0] = (unsigned char)(number >> 24);
    value[1] = (unsigned char)(number >> 16);
    value[2] = (unsigned char)(number >> 8);
    value[3] = (unsigned char)number;
}

static int read_local_port(unsigned short *port) {
    char value[16];
    char *end = NULL;
    unsigned long parsed;
    DWORD length = GetEnvironmentVariableA("WEL_RELAY_LOCAL_PORT", value, sizeof(value));
    if (length == 0 || length >= sizeof(value)) return 0;
    parsed = strtoul(value, &end, 10);
    if (end == value || *end != '\0' || parsed < 1 || parsed > 65535) return 0;
    *port = (unsigned short)parsed;
    return 1;
}

static int is_udp_socket(SOCKET socket_handle) {
    int socket_type = 0;
    int length = sizeof(socket_type);
    return getsockopt(socket_handle, SOL_SOCKET, SO_TYPE, (char *)&socket_type, &length) == 0 && socket_type == SOCK_DGRAM;
}

static int is_synthetic_address(IN_ADDR address) {
    uint32_t host_address = ntohl(address.S_un.S_addr);
    return (host_address & 0xfffe0000U) == 0xc6120000U; /* 198.18.0.0/15 */
}

static int is_discovery_destination(const struct sockaddr *destination, int destination_length) {
    const struct sockaddr_in *ipv4;
    if (destination == NULL || destination_length < (int)sizeof(struct sockaddr_in) || destination->sa_family != AF_INET) return 0;
    ipv4 = (const struct sockaddr_in *)destination;
    return ipv4->sin_port == htons(WEL_DISCOVERY_PORT) && ipv4->sin_addr.S_un.S_addr == INADDR_BROADCAST;
}

static int is_relay_destination(const struct sockaddr *destination, int destination_length, int *is_broadcast) {
    const struct sockaddr_in *ipv4;
    if (destination == NULL || destination_length < (int)sizeof(struct sockaddr_in) || destination->sa_family != AF_INET) return 0;
    ipv4 = (const struct sockaddr_in *)destination;
    if (is_discovery_destination(destination, destination_length)) {
        *is_broadcast = 1;
        return 1;
    }
    if (is_synthetic_address(ipv4->sin_addr)) {
        *is_broadcast = 0;
        return 1;
    }
    return 0;
}

static int ensure_socket_port(SOCKET socket_handle, unsigned short *port, IN_ADDR *address) {
    struct sockaddr_in local;
    int length = sizeof(local);
    if (getsockname(socket_handle, (struct sockaddr *)&local, &length) != 0) return 0;
    if (local.sin_family != AF_INET || local.sin_port == 0) {
        ZeroMemory(&local, sizeof(local));
        local.sin_family = AF_INET;
        local.sin_addr.S_un.S_addr = htonl(INADDR_ANY);
        if (bind(socket_handle, (const struct sockaddr *)&local, sizeof(local)) != 0) return 0;
        length = sizeof(local);
        if (getsockname(socket_handle, (struct sockaddr *)&local, &length) != 0) return 0;
    }
    *port = ntohs(local.sin_port);
    *address = local.sin_addr;
    return *port != 0;
}

static int send_local_frame(
    unsigned char type,
    IN_ADDR source_address,
    IN_ADDR destination_address,
    unsigned short source_port,
    unsigned short destination_port,
    const char *payload,
    int payload_length
) {
    unsigned char *frame;
    int total_length;
    int sent;
    if (g_bridge_socket == INVALID_SOCKET || payload_length < 0 || payload_length > WEL_MAX_DATAGRAM) return 0;
    total_length = WEL_LOCAL_HEADER_LENGTH + payload_length;
    frame = (unsigned char *)HeapAlloc(GetProcessHeap(), 0, total_length);
    if (frame == NULL) return 0;
    ZeroMemory(frame, WEL_LOCAL_HEADER_LENGTH);
    CopyMemory(frame, "WLC1", 4);
    frame[4] = 1;
    frame[5] = type;
    write_u32be(frame + 8, ntohl(source_address.S_un.S_addr));
    write_u32be(frame + 12, ntohl(destination_address.S_un.S_addr));
    write_u16be(frame + 16, source_port);
    write_u16be(frame + 18, destination_port);
    write_u16be(frame + 20, (unsigned short)payload_length);
    if (payload_length > 0) CopyMemory(frame + WEL_LOCAL_HEADER_LENGTH, payload, payload_length);
    sent = send(g_bridge_socket, (const char *)frame, total_length, 0);
    HeapFree(GetProcessHeap(), 0, frame);
    return sent == total_length;
}

static void enqueue_delivery(wel_delivery *delivery) {
    DWORD index;
    EnterCriticalSection(&g_queue_lock);
    for (index = 0; index < WEL_QUEUE_LENGTH; ++index) {
        if (g_deliveries[index].payload == NULL) {
            g_deliveries[index] = *delivery;
            LeaveCriticalSection(&g_queue_lock);
            return;
        }
    }
    /* Prefer the newest game packet. Discovery retries, while old packets do
     * not become useful after the game has advanced to a later state. */
    HeapFree(GetProcessHeap(), 0, g_deliveries[0].payload);
    g_deliveries[0] = *delivery;
    LeaveCriticalSection(&g_queue_lock);
}

static int take_delivery(SOCKET socket_handle, wel_delivery *delivery) {
    struct sockaddr_in local;
    int local_length = sizeof(local);
    DWORD index;
    unsigned short local_port;
    if (getsockname(socket_handle, (struct sockaddr *)&local, &local_length) != 0 || local.sin_family != AF_INET) return 0;
    local_port = ntohs(local.sin_port);
    if (local_port == 0) return 0;
    EnterCriticalSection(&g_queue_lock);
    for (index = 0; index < WEL_QUEUE_LENGTH; ++index) {
        if (g_deliveries[index].payload != NULL && g_deliveries[index].destination_port == local_port) {
            *delivery = g_deliveries[index];
            ZeroMemory(&g_deliveries[index], sizeof(g_deliveries[index]));
            LeaveCriticalSection(&g_queue_lock);
            return 1;
        }
    }
    LeaveCriticalSection(&g_queue_lock);
    return 0;
}

static void receive_from_bridge(void) {
    unsigned char *packet = (unsigned char *)HeapAlloc(GetProcessHeap(), 0, WEL_LOCAL_HEADER_LENGTH + WEL_MAX_DATAGRAM);
    if (packet == NULL) return;
    while (InterlockedCompareExchange(&g_stopping, 0, 0) == 0) {
        struct sockaddr_in sender;
        int sender_length = sizeof(sender);
        int received = recvfrom(g_bridge_socket, (char *)packet, WEL_LOCAL_HEADER_LENGTH + WEL_MAX_DATAGRAM, 0,
            (struct sockaddr *)&sender, &sender_length);
        unsigned short payload_length;
        wel_delivery delivery;
        if (received <= 0) break;
        if (sender.sin_family != AF_INET || sender.sin_addr.S_un.S_addr != htonl(INADDR_LOOPBACK) || received < WEL_LOCAL_HEADER_LENGTH) continue;
        if (memcmp(packet, "WLC1", 4) != 0 || packet[4] != 1 || packet[5] != WEL_LOCAL_DELIVERY) continue;
        payload_length = read_u16be(packet + 20);
        if (received != WEL_LOCAL_HEADER_LENGTH + payload_length) continue;
        ZeroMemory(&delivery, sizeof(delivery));
        delivery.length = payload_length;
        delivery.destination_port = read_u16be(packet + 18);
        delivery.source_port = read_u16be(packet + 16);
        delivery.source_address.S_un.S_addr = htonl(read_u32be(packet + 8));
        delivery.payload = (char *)HeapAlloc(GetProcessHeap(), 0, payload_length == 0 ? 1 : payload_length);
        if (delivery.payload == NULL) continue;
        if (payload_length > 0) CopyMemory(delivery.payload, packet + WEL_LOCAL_HEADER_LENGTH, payload_length);
        enqueue_delivery(&delivery);
    }
    HeapFree(GetProcessHeap(), 0, packet);
}

static DWORD WINAPI bridge_receiver_thread(LPVOID unused) {
    (void)unused;
    receive_from_bridge();
    return 0;
}

static int WSAAPI wel_sendto(SOCKET socket_handle, const char *buffer, int buffer_length, int flags, const struct sockaddr *destination, int destination_length) {
    const struct sockaddr_in *ipv4;
    IN_ADDR source_address;
    unsigned short source_port;
    int is_broadcast = 0;
    if (g_real_sendto == NULL || !is_udp_socket(socket_handle) || !is_relay_destination(destination, destination_length, &is_broadcast)) {
        return g_real_sendto(socket_handle, buffer, buffer_length, flags, destination, destination_length);
    }
    if (!ensure_socket_port(socket_handle, &source_port, &source_address)) return SOCKET_ERROR;
    ipv4 = (const struct sockaddr_in *)destination;
    if (!send_local_frame(is_broadcast ? WEL_LOCAL_BROADCAST : WEL_LOCAL_UNICAST, source_address, ipv4->sin_addr,
        source_port, ntohs(ipv4->sin_port), buffer, buffer_length)) {
        WSASetLastError(WSAENETDOWN);
        return SOCKET_ERROR;
    }
    return buffer_length;
}

static int WSAAPI wel_wsasendto(SOCKET socket_handle, LPWSABUF buffers, DWORD buffer_count, LPDWORD bytes_sent, DWORD flags,
    const struct sockaddr *destination, int destination_length, LPWSAOVERLAPPED overlapped, LPWSAOVERLAPPED_COMPLETION_ROUTINE completion_routine) {
    const struct sockaddr_in *ipv4;
    IN_ADDR source_address;
    unsigned short source_port;
    DWORD index;
    DWORD total = 0;
    char *payload;
    char *cursor;
    int is_broadcast = 0;
    if (g_real_wsasendto == NULL || overlapped != NULL || completion_routine != NULL || !is_udp_socket(socket_handle) ||
        !is_relay_destination(destination, destination_length, &is_broadcast)) {
        return g_real_wsasendto(socket_handle, buffers, buffer_count, bytes_sent, flags, destination, destination_length, overlapped, completion_routine);
    }
    for (index = 0; index < buffer_count; ++index) {
        if (buffers[index].len > WEL_MAX_DATAGRAM - total) { WSASetLastError(WSAEMSGSIZE); return SOCKET_ERROR; }
        total += buffers[index].len;
    }
    payload = (char *)HeapAlloc(GetProcessHeap(), 0, total == 0 ? 1 : total);
    if (payload == NULL) { WSASetLastError(WSAENOBUFS); return SOCKET_ERROR; }
    cursor = payload;
    for (index = 0; index < buffer_count; ++index) { CopyMemory(cursor, buffers[index].buf, buffers[index].len); cursor += buffers[index].len; }
    if (!ensure_socket_port(socket_handle, &source_port, &source_address)) { HeapFree(GetProcessHeap(), 0, payload); return SOCKET_ERROR; }
    ipv4 = (const struct sockaddr_in *)destination;
    if (!send_local_frame(is_broadcast ? WEL_LOCAL_BROADCAST : WEL_LOCAL_UNICAST, source_address, ipv4->sin_addr,
        source_port, ntohs(ipv4->sin_port), payload, (int)total)) {
        HeapFree(GetProcessHeap(), 0, payload);
        WSASetLastError(WSAENETDOWN);
        return SOCKET_ERROR;
    }
    HeapFree(GetProcessHeap(), 0, payload);
    if (bytes_sent != NULL) *bytes_sent = total;
    return 0;
}

static int copy_delivery(wel_delivery *delivery, char *buffer, int buffer_length, struct sockaddr *source, int *source_length) {
    struct sockaddr_in source_address;
    if (delivery->length > buffer_length) {
        HeapFree(GetProcessHeap(), 0, delivery->payload);
        WSASetLastError(WSAEMSGSIZE);
        return SOCKET_ERROR;
    }
    if (delivery->length > 0) CopyMemory(buffer, delivery->payload, delivery->length);
    if (source != NULL && source_length != NULL && *source_length >= (int)sizeof(source_address)) {
        ZeroMemory(&source_address, sizeof(source_address));
        source_address.sin_family = AF_INET;
        source_address.sin_addr = delivery->source_address;
        source_address.sin_port = htons(delivery->source_port);
        CopyMemory(source, &source_address, sizeof(source_address));
        *source_length = sizeof(source_address);
    }
    HeapFree(GetProcessHeap(), 0, delivery->payload);
    return delivery->length;
}

static int WSAAPI wel_recvfrom(SOCKET socket_handle, char *buffer, int buffer_length, int flags, struct sockaddr *source, int *source_length) {
    wel_delivery delivery;
    if (g_real_recvfrom == NULL || !is_udp_socket(socket_handle) || !take_delivery(socket_handle, &delivery)) {
        return g_real_recvfrom(socket_handle, buffer, buffer_length, flags, source, source_length);
    }
    return copy_delivery(&delivery, buffer, buffer_length, source, source_length);
}

static int WSAAPI wel_wsarecvfrom(SOCKET socket_handle, LPWSABUF buffers, DWORD buffer_count, LPDWORD bytes_received, LPDWORD flags,
    struct sockaddr *source, LPINT source_length, LPWSAOVERLAPPED overlapped, LPWSAOVERLAPPED_COMPLETION_ROUTINE completion_routine) {
    wel_delivery delivery;
    DWORD index;
    DWORD capacity = 0;
    DWORD copied = 0;
    if (g_real_wsarecvfrom == NULL || overlapped != NULL || completion_routine != NULL || !is_udp_socket(socket_handle) || !take_delivery(socket_handle, &delivery)) {
        return g_real_wsarecvfrom(socket_handle, buffers, buffer_count, bytes_received, flags, source, source_length, overlapped, completion_routine);
    }
    for (index = 0; index < buffer_count; ++index) capacity += buffers[index].len;
    if ((DWORD)delivery.length > capacity) {
        HeapFree(GetProcessHeap(), 0, delivery.payload);
        WSASetLastError(WSAEMSGSIZE);
        return SOCKET_ERROR;
    }
    for (index = 0; index < buffer_count && copied < (DWORD)delivery.length; ++index) {
        DWORD length = buffers[index].len;
        if (length > (DWORD)delivery.length - copied) length = (DWORD)delivery.length - copied;
        if (length > 0) CopyMemory(buffers[index].buf, delivery.payload + copied, length);
        copied += length;
    }
    if (source != NULL && source_length != NULL && *source_length >= (int)sizeof(struct sockaddr_in)) {
        struct sockaddr_in source_address;
        ZeroMemory(&source_address, sizeof(source_address));
        source_address.sin_family = AF_INET;
        source_address.sin_addr = delivery.source_address;
        source_address.sin_port = htons(delivery.source_port);
        CopyMemory(source, &source_address, sizeof(source_address));
        *source_length = sizeof(source_address);
    }
    HeapFree(GetProcessHeap(), 0, delivery.payload);
    if (bytes_received != NULL) *bytes_received = copied;
    return 0;
}

static void patch_import_slot(PULONG_PTR slot, ULONG_PTR replacement) {
    DWORD old_protection;
    if (*slot == replacement || !VirtualProtect(slot, sizeof(*slot), PAGE_READWRITE, &old_protection)) return;
    *slot = replacement;
    VirtualProtect(slot, sizeof(*slot), old_protection, &old_protection);
}

static void patch_module_imports(HMODULE module) {
    PIMAGE_DOS_HEADER dos_header;
    PIMAGE_NT_HEADERS nt_headers;
    PIMAGE_IMPORT_DESCRIPTOR imports;
    DWORD import_rva;
    if (module == NULL || module == g_hook_module) return;
    __try {
        dos_header = (PIMAGE_DOS_HEADER)module;
        if (dos_header->e_magic != IMAGE_DOS_SIGNATURE) return;
        nt_headers = (PIMAGE_NT_HEADERS)((BYTE *)module + dos_header->e_lfanew);
        if (nt_headers->Signature != IMAGE_NT_SIGNATURE) return;
        import_rva = nt_headers->OptionalHeader.DataDirectory[IMAGE_DIRECTORY_ENTRY_IMPORT].VirtualAddress;
        if (import_rva == 0) return;
        imports = (PIMAGE_IMPORT_DESCRIPTOR)((BYTE *)module + import_rva);
        while (imports->Name != 0) {
            const char *library_name = (const char *)module + imports->Name;
            PIMAGE_THUNK_DATA thunk = (PIMAGE_THUNK_DATA)((BYTE *)module + imports->FirstThunk);
            PIMAGE_THUNK_DATA names = imports->OriginalFirstThunk == 0 ? NULL : (PIMAGE_THUNK_DATA)((BYTE *)module + imports->OriginalFirstThunk);
            if (_stricmp(library_name, "ws2_32.dll") != 0 && _stricmp(library_name, "wsock32.dll") != 0) { ++imports; continue; }
            while (thunk->u1.Function != 0) {
                PULONG_PTR slot = (PULONG_PTR)&thunk->u1.Function;
                if (names != NULL && !IMAGE_SNAP_BY_ORDINAL(names->u1.Ordinal)) {
                    PIMAGE_IMPORT_BY_NAME import_name = (PIMAGE_IMPORT_BY_NAME)((BYTE *)module + names->u1.AddressOfData);
                    if (strcmp((const char *)import_name->Name, "sendto") == 0) patch_import_slot(slot, (ULONG_PTR)wel_sendto);
                    else if (strcmp((const char *)import_name->Name, "recvfrom") == 0) patch_import_slot(slot, (ULONG_PTR)wel_recvfrom);
                    else if (strcmp((const char *)import_name->Name, "WSASendTo") == 0) patch_import_slot(slot, (ULONG_PTR)wel_wsasendto);
                    else if (strcmp((const char *)import_name->Name, "WSARecvFrom") == 0) patch_import_slot(slot, (ULONG_PTR)wel_wsarecvfrom);
                } else {
                    if (*slot == (ULONG_PTR)g_real_sendto) patch_import_slot(slot, (ULONG_PTR)wel_sendto);
                    else if (*slot == (ULONG_PTR)g_real_recvfrom) patch_import_slot(slot, (ULONG_PTR)wel_recvfrom);
                    else if (*slot == (ULONG_PTR)g_real_wsasendto) patch_import_slot(slot, (ULONG_PTR)wel_wsasendto);
                    else if (*slot == (ULONG_PTR)g_real_wsarecvfrom) patch_import_slot(slot, (ULONG_PTR)wel_wsarecvfrom);
                }
                if (names != NULL) ++names;
                ++thunk;
            }
            ++imports;
        }
    } __except (EXCEPTION_EXECUTE_HANDLER) { return; }
}

static void patch_all_modules(void) {
    HMODULE modules[512];
    DWORD required = 0;
    DWORD index;
    DWORD count;
    if (!EnumProcessModules(GetCurrentProcess(), modules, sizeof(modules), &required)) return;
    count = required / sizeof(HMODULE);
    if (count > ARRAYSIZE(modules)) count = ARRAYSIZE(modules);
    for (index = 0; index < count; ++index) patch_module_imports(modules[index]);
}

static DWORD WINAPI module_watch_thread(LPVOID unused) {
    (void)unused;
    while (InterlockedCompareExchange(&g_stopping, 0, 0) == 0) { patch_all_modules(); Sleep(250); }
    return 0;
}

static void signal_hook_ready(void) {
    char event_name[128];
    DWORD length = GetEnvironmentVariableA("WEL_HOOK_READY_EVENT", event_name, sizeof(event_name));
    HANDLE event;
    if (length == 0 || length >= sizeof(event_name)) return;
    event = OpenEventA(EVENT_MODIFY_STATE, FALSE, event_name);
    if (event != NULL) { SetEvent(event); CloseHandle(event); }
}

static int initialize_hook(void) {
    HMODULE winsock;
    struct sockaddr_in bridge_address;
    WSADATA wsa;
    unsigned short local_port;
    HANDLE worker;
    if (!read_local_port(&local_port) || WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return 0;
    winsock = GetModuleHandleW(L"ws2_32.dll");
    if (winsock == NULL) winsock = LoadLibraryW(L"ws2_32.dll");
    if (winsock == NULL) return 0;
    g_real_sendto = (wel_sendto_fn)GetProcAddress(winsock, "sendto");
    g_real_recvfrom = (wel_recvfrom_fn)GetProcAddress(winsock, "recvfrom");
    g_real_wsasendto = (wel_wsasendto_fn)GetProcAddress(winsock, "WSASendTo");
    g_real_wsarecvfrom = (wel_wsarecvfrom_fn)GetProcAddress(winsock, "WSARecvFrom");
    if (g_real_sendto == NULL || g_real_recvfrom == NULL || g_real_wsasendto == NULL || g_real_wsarecvfrom == NULL) return 0;
    g_bridge_socket = socket(AF_INET, SOCK_DGRAM, IPPROTO_UDP);
    if (g_bridge_socket == INVALID_SOCKET) return 0;
    ZeroMemory(&bridge_address, sizeof(bridge_address));
    bridge_address.sin_family = AF_INET;
    bridge_address.sin_addr.S_un.S_addr = htonl(INADDR_LOOPBACK);
    bridge_address.sin_port = htons(local_port);
    if (connect(g_bridge_socket, (const struct sockaddr *)&bridge_address, sizeof(bridge_address)) != 0) { closesocket(g_bridge_socket); g_bridge_socket = INVALID_SOCKET; return 0; }
    InitializeCriticalSection(&g_queue_lock);
    send_local_frame(WEL_LOCAL_HELLO, bridge_address.sin_addr, bridge_address.sin_addr, 0, 0, NULL, 0);
    patch_all_modules();
    worker = CreateThread(NULL, 0, bridge_receiver_thread, NULL, 0, NULL);
    if (worker == NULL) return 0;
    CloseHandle(worker);
    worker = CreateThread(NULL, 0, module_watch_thread, NULL, 0, NULL);
    if (worker != NULL) CloseHandle(worker);
    return 1;
}

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved) {
    (void)reserved;
    if (reason == DLL_PROCESS_ATTACH) {
        g_hook_module = instance;
        DisableThreadLibraryCalls(instance);
        if (initialize_hook()) signal_hook_ready();
    } else if (reason == DLL_PROCESS_DETACH) {
        DWORD index;
        InterlockedExchange(&g_stopping, 1);
        if (g_bridge_socket != INVALID_SOCKET) { closesocket(g_bridge_socket); g_bridge_socket = INVALID_SOCKET; }
        for (index = 0; index < WEL_QUEUE_LENGTH; ++index) HeapFree(GetProcessHeap(), 0, g_deliveries[index].payload);
    }
    return TRUE;
}
