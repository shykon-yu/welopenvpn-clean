#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <commctrl.h>
#include <iphlpapi.h>
#include <shlobj.h>
#include <shellapi.h>
#include <tlhelp32.h>
#include <stdio.h>
#include <stdint.h>
#include <stdarg.h>
#include <wchar.h>

#pragma comment(lib, "Iphlpapi.lib")
#pragma comment(lib, "Shell32.lib")
#pragma comment(lib, "Comctl32.lib")

#define ID_ROLE 1001
#define ID_START 1002
#define ID_STOP 1003
#define ID_OPEN 1004
#define WM_STATUS (WM_APP + 1)
#define WM_CAPTURE_READY (WM_APP + 2)
#define WM_CAPTURE_DONE (WM_APP + 3)
#define WM_CAPTURE_FAILED (WM_APP + 4)
#define MAX_CAPTURE_PATH 1024
#define MAX_ZIP_ENTRIES 128

typedef enum { CAPTURE_IDLE, CAPTURE_STARTING, CAPTURE_RUNNING, CAPTURE_STOPPING } capture_state;
typedef enum { CAPTURE_PKTMON, CAPTURE_NETSH } capture_mode;

typedef struct {
    wchar_t work_directory[MAX_CAPTURE_PATH];
    wchar_t output_file[MAX_CAPTURE_PATH];
    wchar_t etl_file[MAX_CAPTURE_PATH];
    wchar_t role[16];
    wchar_t pktmon_path[MAX_PATH];
    wchar_t netsh_path[MAX_PATH];
    capture_mode mode;
    FILETIME started;
} capture_session;

typedef struct {
    char name[512];
    DWORD crc;
    DWORD size;
    DWORD offset;
    WORD time;
    WORD date;
} zip_entry;

static HWND g_main_window;
static HWND g_role;
static HWND g_start_button;
static HWND g_stop_button;
static HWND g_open_button;
static HWND g_status;
static volatile LONG g_state = CAPTURE_IDLE;
static capture_session g_session;
static DWORD g_crc_table[256];

static void make_path(wchar_t *result, size_t count, const wchar_t *directory, const wchar_t *name) {
    _snwprintf_s(result, count, _TRUNCATE, L"%ls\\%ls", directory, name);
}

static void post_status(const wchar_t *format, ...) {
    wchar_t stack_buffer[1024];
    wchar_t *message;
    va_list args;
    va_start(args, format);
    _vsnwprintf_s(stack_buffer, ARRAYSIZE(stack_buffer), _TRUNCATE, format, args);
    va_end(args);
    message = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, (wcslen(stack_buffer) + 1) * sizeof(wchar_t));
    if (message == NULL) return;
    wcscpy_s(message, wcslen(stack_buffer) + 1, stack_buffer);
    PostMessageW(g_main_window, WM_STATUS, 0, (LPARAM)message);
}

static void append_status(const wchar_t *message) {
    int length = GetWindowTextLengthW(g_status);
    SendMessageW(g_status, EM_SETSEL, length, length);
    SendMessageW(g_status, EM_REPLACESEL, FALSE, (LPARAM)message);
    SendMessageW(g_status, EM_REPLACESEL, FALSE, (LPARAM)L"\r\n");
}

static int ensure_directory(const wchar_t *directory) {
    if (CreateDirectoryW(directory, NULL)) return 1;
    return GetLastError() == ERROR_ALREADY_EXISTS;
}

static int locate_command(const wchar_t *name, wchar_t *path, DWORD path_count) {
    wchar_t windows_directory[MAX_PATH];
    wchar_t native_path[MAX_PATH];
    DWORD length = GetWindowsDirectoryW(windows_directory, ARRAYSIZE(windows_directory));
    path[0] = L'\0';
    if (length > 0 && length < ARRAYSIZE(windows_directory)) {
        _snwprintf_s(native_path, ARRAYSIZE(native_path), _TRUNCATE, L"%ls\\Sysnative\\%ls", windows_directory, name);
        if (GetFileAttributesW(native_path) != INVALID_FILE_ATTRIBUTES) {
            wcsncpy_s(path, path_count, native_path, _TRUNCATE);
            return 1;
        }
    }
    length = SearchPathW(NULL, name, NULL, path_count, path, NULL);
    return length > 0 && length < path_count;
}

static DWORD run_command(const wchar_t *command_line, const wchar_t *working_directory, const wchar_t *output_file, DWORD timeout_ms) {
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    SECURITY_ATTRIBUTES security;
    HANDLE output;
    HANDLE input;
    wchar_t *mutable_command;
    DWORD result = ERROR_GEN_FAILURE;
    size_t length = wcslen(command_line);

    ZeroMemory(&security, sizeof(security));
    security.nLength = sizeof(security);
    security.bInheritHandle = TRUE;
    output = CreateFileW(output_file, GENERIC_WRITE, FILE_SHARE_READ, &security, CREATE_ALWAYS, FILE_ATTRIBUTE_NORMAL, NULL);
    if (output == INVALID_HANDLE_VALUE) return GetLastError();
    input = CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, NULL);
    if (input == INVALID_HANDLE_VALUE) { CloseHandle(output); return GetLastError(); }
    mutable_command = (wchar_t *)HeapAlloc(GetProcessHeap(), 0, (length + 1) * sizeof(wchar_t));
    if (mutable_command == NULL) { CloseHandle(input); CloseHandle(output); return ERROR_NOT_ENOUGH_MEMORY; }
    wcscpy_s(mutable_command, length + 1, command_line);
    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESTDHANDLES;
    startup.hStdInput = input;
    startup.hStdOutput = output;
    startup.hStdError = output;
    if (CreateProcessW(NULL, mutable_command, NULL, NULL, TRUE, CREATE_NO_WINDOW, NULL, working_directory, &startup, &process)) {
        DWORD waited = WaitForSingleObject(process.hProcess, timeout_ms);
        if (waited == WAIT_OBJECT_0) GetExitCodeProcess(process.hProcess, &result);
        else {
            TerminateProcess(process.hProcess, ERROR_TIMEOUT);
            result = ERROR_TIMEOUT;
        }
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
    } else result = GetLastError();
    HeapFree(GetProcessHeap(), 0, mutable_command);
    CloseHandle(input);
    CloseHandle(output);
    return result;
}

static void run_snapshot_command(const wchar_t *file_name, const wchar_t *command) {
    wchar_t output[MAX_CAPTURE_PATH];
    make_path(output, ARRAYSIZE(output), g_session.work_directory, file_name);
    run_command(command, g_session.work_directory, output, 30000);
}

static void read_log_tail(const wchar_t *file_name, wchar_t *buffer, size_t count) {
    wchar_t path[MAX_CAPTURE_PATH];
    wchar_t diag_path[MAX_CAPTURE_PATH];
    FILE *file;
    FILE *diag_file;
    long length;
    unsigned char raw[2048];
    size_t got;
    UINT codepage = CP_ACP;
    size_t text_offset = 0;
    buffer[0] = L'\0';
    if (count < 2) return;
    make_path(path, ARRAYSIZE(path), g_session.work_directory, file_name);
    file = _wfopen(path, L"rb");
    if (file == NULL) return;
    fseek(file, 0, SEEK_END);
    length = ftell(file);
    if (length < 0) { fclose(file); return; }
    if (length > (long)sizeof(raw) - 1) fseek(file, length - ((long)sizeof(raw) - 1), SEEK_SET);
    else fseek(file, 0, SEEK_SET);
    got = fread(raw, 1, sizeof(raw) - 1, file);
    fclose(file);

    // Diagnostic dump: write the head bytes of the file so we can confirm
    // what encoding pktmon / netsh actually produced when reports come back.
    make_path(diag_path, ARRAYSIZE(diag_path), g_session.work_directory, L"read-log-tail.hex");
    diag_file = _wfopen(diag_path, L"ab");
    if (diag_file != NULL) {
        wchar_t hex_line[1100];
        wchar_t hex_chunk[8];
        size_t dump_i;
        _snwprintf_s(hex_line, ARRAYSIZE(hex_line), _TRUNCATE, L"%ls: len=%ld head=", file_name, length);
        for (dump_i = 0; dump_i < got && dump_i < 32; dump_i++) {
            _snwprintf_s(hex_chunk, ARRAYSIZE(hex_chunk), _TRUNCATE, L"%02X ", raw[dump_i]);
            wcsncat_s(hex_line, ARRAYSIZE(hex_line), hex_chunk, _TRUNCATE);
        }
        write_utf8_line(diag_file, hex_line);
        fclose(diag_file);
    }

    if (got >= 2 && raw[0] == 0xFF && raw[1] == 0xFE) {
        // UTF-16 LE with BOM (FF FE) — pktmon classic console output.
        wchar_t *src = (wchar_t *)(raw + 2);
        size_t text_bytes = (got - 2) & ~(size_t)1;
        size_t text_chars = text_bytes / sizeof(wchar_t);
        size_t max_chars = (count / sizeof(wchar_t)) - 1;
        if (text_chars > max_chars) text_chars = max_chars;
        wcsncpy_s(buffer, count, src, text_chars);
        buffer[text_chars] = L'\0';
        return;
    }
    if (got >= 2 && raw[0] == 0xFE && raw[1] == 0xFF) {
        // UTF-16 BE with BOM (FE FF) — swap byte pairs into LE wchar_t.
        unsigned char *src = raw + 2;
        size_t text_bytes = (got - 2) & ~(size_t)1;
        size_t text_chars = text_bytes / sizeof(wchar_t);
        size_t max_chars = (count / sizeof(wchar_t)) - 1;
        size_t be_i;
        if (text_chars > max_chars) text_chars = max_chars;
        for (be_i = 0; be_i < text_chars; be_i++) {
            buffer[be_i] = (wchar_t)((src[be_i * 2] << 8) | src[be_i * 2 + 1]);
        }
        buffer[text_chars] = L'\0';
        return;
    }
    if (got >= 3 && raw[0] == 0xEF && raw[1] == 0xBB && raw[2] == 0xBF) {
        // UTF-8 with BOM — modern pktmon / netsh on Win10 1903+.
        text_offset = 3;
        codepage = CP_UTF8;
    } else {
        // No BOM: probe UTF-8 first (modern pktmon default), fall back to
        // CP_ACP (legacy netsh trace, ANSI captures). raw[got]=0 ensures the
        // -1 length in MultiByteToWideChar sees a NUL terminator.
        const char *probe = (const char *)raw;
        raw[got] = 0;
        if (MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, probe, -1, NULL, 0) == 0) {
            codepage = CP_ACP;
        } else {
            codepage = CP_UTF8;
        }
    }
    raw[got] = 0;
    MultiByteToWideChar(codepage, 0, (const char *)(raw + text_offset), -1, buffer, (int)count - 1);
}

static void write_utf8_line(FILE *file, const wchar_t *text) {
    char buffer[2048];
    int count = WideCharToMultiByte(CP_UTF8, 0, text, -1, buffer, sizeof(buffer) - 2, NULL, NULL);
    if (count <= 0) return;
    fwrite(buffer, 1, (size_t)count - 1, file);
    fwrite("\r\n", 1, 2, file);
}

static void wide_to_utf8(const wchar_t *text, char *buffer, size_t count) {
    if (WideCharToMultiByte(CP_UTF8, 0, text, -1, buffer, (int)count, NULL, NULL) <= 0) strcpy_s(buffer, count, "?");
}

static void write_capture_info(const wchar_t *stage) {
    wchar_t file_name[MAX_CAPTURE_PATH];
    wchar_t line[1024];
    SYSTEMTIME now;
    FILE *file;
    make_path(file_name, ARRAYSIZE(file_name), g_session.work_directory, L"capture-info.txt");
    file = _wfopen(file_name, L"ab");
    if (file == NULL) return;
    GetLocalTime(&now);
    _snwprintf_s(line, ARRAYSIZE(line), _TRUNCATE, L"%04u-%02u-%02u %02u:%02u:%02u | %ls | role=%ls | mode=%ls",
        now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond, stage, g_session.role,
        g_session.mode == CAPTURE_PKTMON ? L"pktmon" : L"netsh-trace");
    write_utf8_line(file, line);
    fclose(file);
}

static int is_target_process(const wchar_t *name) {
    return _wcsicmp(name, L"WE8.exe") == 0 || _wcsicmp(name, L"WE8LE.exe") == 0 ||
        _wcsicmp(name, L"edge.exe") == 0 || _wcsicmp(name, L"fonta0.exe") == 0;
}

typedef struct { DWORD ids[32]; DWORD count; } target_processes;

static void write_process_modules(FILE *file, DWORD process_id) {
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPMODULE | TH32CS_SNAPMODULE32, process_id);
    MODULEENTRY32W module;
    if (snapshot == INVALID_HANDLE_VALUE) return;
    ZeroMemory(&module, sizeof(module));
    module.dwSize = sizeof(module);
    if (Module32FirstW(snapshot, &module)) {
        do {
            char module_name[MAX_MODULE_NAME32 + 1];
            char module_path[MAX_PATH * 3];
            wide_to_utf8(module.szModule, module_name, sizeof(module_name));
            wide_to_utf8(module.szExePath, module_path, sizeof(module_path));
            fprintf(file, "  MODULE %s | %s\r\n", module_name, module_path);
        } while (Module32NextW(snapshot, &module));
    }
    CloseHandle(snapshot);
}

static target_processes write_target_processes(FILE *file) {
    PROCESSENTRY32W entry;
    HANDLE snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
    target_processes targets;
    ZeroMemory(&targets, sizeof(targets));
    if (snapshot == INVALID_HANDLE_VALUE) return targets;
    ZeroMemory(&entry, sizeof(entry));
    entry.dwSize = sizeof(entry);
    if (Process32FirstW(snapshot, &entry)) {
        do {
            if (is_target_process(entry.szExeFile)) {
                char process_name[MAX_PATH * 3];
                if (targets.count < ARRAYSIZE(targets.ids)) targets.ids[targets.count++] = entry.th32ProcessID;
                wide_to_utf8(entry.szExeFile, process_name, sizeof(process_name));
                fprintf(file, "PROCESS pid=%lu name=%s\r\n", (unsigned long)entry.th32ProcessID, process_name);
                write_process_modules(file, entry.th32ProcessID);
            }
        } while (Process32NextW(snapshot, &entry));
    }
    CloseHandle(snapshot);
    return targets;
}

static int target_contains(const target_processes *targets, DWORD process_id) {
    DWORD index;
    for (index = 0; index < targets->count; ++index) if (targets->ids[index] == process_id) return 1;
    return 0;
}

static void format_ipv4(DWORD address, char *result, size_t count) {
    DWORD host = ntohl(address);
    _snprintf_s(result, count, _TRUNCATE, "%u.%u.%u.%u", (unsigned)((host >> 24) & 255), (unsigned)((host >> 16) & 255),
        (unsigned)((host >> 8) & 255), (unsigned)(host & 255));
}

static void write_socket_snapshot(FILE *file, const target_processes *targets) {
    PMIB_UDPTABLE_OWNER_PID udp_table = NULL;
    PMIB_TCPTABLE_OWNER_PID tcp_table = NULL;
    DWORD bytes = 0;
    DWORD index;
    if (GetExtendedUdpTable(NULL, &bytes, FALSE, AF_INET, UDP_TABLE_OWNER_PID, 0) == ERROR_INSUFFICIENT_BUFFER) {
        udp_table = (PMIB_UDPTABLE_OWNER_PID)HeapAlloc(GetProcessHeap(), 0, bytes);
        if (udp_table != NULL && GetExtendedUdpTable(udp_table, &bytes, FALSE, AF_INET, UDP_TABLE_OWNER_PID, 0) == NO_ERROR) {
            for (index = 0; index < udp_table->dwNumEntries; ++index) {
                MIB_UDPROW_OWNER_PID *row = &udp_table->table[index];
                char local[32];
                if (!target_contains(targets, row->dwOwningPid)) continue;
                format_ipv4(row->dwLocalAddr, local, sizeof(local));
                fprintf(file, "UDP pid=%lu %s:%u\r\n", (unsigned long)row->dwOwningPid, local, (unsigned)ntohs((u_short)row->dwLocalPort));
            }
        }
    }
    HeapFree(GetProcessHeap(), 0, udp_table);
    bytes = 0;
    if (GetExtendedTcpTable(NULL, &bytes, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) == ERROR_INSUFFICIENT_BUFFER) {
        tcp_table = (PMIB_TCPTABLE_OWNER_PID)HeapAlloc(GetProcessHeap(), 0, bytes);
        if (tcp_table != NULL && GetExtendedTcpTable(tcp_table, &bytes, FALSE, AF_INET, TCP_TABLE_OWNER_PID_ALL, 0) == NO_ERROR) {
            for (index = 0; index < tcp_table->dwNumEntries; ++index) {
                MIB_TCPROW_OWNER_PID *row = &tcp_table->table[index];
                char local[32];
                char remote[32];
                if (!target_contains(targets, row->dwOwningPid)) continue;
                format_ipv4(row->dwLocalAddr, local, sizeof(local));
                format_ipv4(row->dwRemoteAddr, remote, sizeof(remote));
                fprintf(file, "TCP pid=%lu state=%lu %s:%u -> %s:%u\r\n", (unsigned long)row->dwOwningPid,
                    (unsigned long)row->dwState, local, (unsigned)ntohs((u_short)row->dwLocalPort),
                    remote, (unsigned)ntohs((u_short)row->dwRemotePort));
            }
        }
    }
    HeapFree(GetProcessHeap(), 0, tcp_table);
}

static void append_game_timeline(void) {
    wchar_t path[MAX_CAPTURE_PATH];
    SYSTEMTIME now;
    FILE *file;
    target_processes targets;
    make_path(path, ARRAYSIZE(path), g_session.work_directory, L"game-sockets-timeline.txt");
    file = _wfopen(path, L"ab");
    if (file == NULL) return;
    GetLocalTime(&now);
    fprintf(file, "\r\n==== %04u-%02u-%02u %02u:%02u:%02u ====\r\n", now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond);
    targets = write_target_processes(file);
    if (targets.count == 0) fprintf(file, "No WE8/edge/fonta0 target process found.\r\n");
    else write_socket_snapshot(file, &targets);
    fclose(file);
}

static DWORD WINAPI timeline_thread(LPVOID unused) {
    (void)unused;
    while (InterlockedCompareExchange(&g_state, CAPTURE_RUNNING, CAPTURE_RUNNING) == CAPTURE_RUNNING) {
        append_game_timeline();
        Sleep(2000);
    }
    return 0;
}

static void collect_snapshot(const wchar_t *prefix) {
    wchar_t file[128];
    _snwprintf_s(file, ARRAYSIZE(file), _TRUNCATE, L"%ls-ipconfig.txt", prefix);
    run_snapshot_command(file, L"ipconfig.exe /all");
    _snwprintf_s(file, ARRAYSIZE(file), _TRUNCATE, L"%ls-routes.txt", prefix);
    run_snapshot_command(file, L"route.exe print -4");
    _snwprintf_s(file, ARRAYSIZE(file), _TRUNCATE, L"%ls-interfaces.txt", prefix);
    run_snapshot_command(file, L"netsh.exe interface ipv4 show interfaces");
    _snwprintf_s(file, ARRAYSIZE(file), _TRUNCATE, L"%ls-endpoints.txt", prefix);
    run_snapshot_command(file, L"netstat.exe -ano");
    _snwprintf_s(file, ARRAYSIZE(file), _TRUNCATE, L"%ls-firewall.txt", prefix);
    run_snapshot_command(file, L"netsh.exe advfirewall show allprofiles");
    _snwprintf_s(file, ARRAYSIZE(file), _TRUNCATE, L"%ls-firewall-rules.txt", prefix);
    run_snapshot_command(file, L"netsh.exe advfirewall firewall show rule name=all verbose");
    _snwprintf_s(file, ARRAYSIZE(file), _TRUNCATE, L"%ls-drivers.txt", prefix);
    run_snapshot_command(file, L"driverquery.exe /v");
    _snwprintf_s(file, ARRAYSIZE(file), _TRUNCATE, L"%ls-adapter-registry.txt", prefix);
    run_snapshot_command(file, L"reg.exe query HKLM\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4D36E972-E325-11CE-BFC1-08002BE10318} /s");
}

static void copy_wel_logs(void) {
    typedef struct { wchar_t name[MAX_PATH]; FILETIME modified; } log_candidate;
    wchar_t logs[MAX_CAPTURE_PATH];
    wchar_t search[MAX_CAPTURE_PATH];
    WIN32_FIND_DATAW data;
    HANDLE find;
    log_candidate candidates[64];
    DWORD count = 0;
    DWORD index;
    DWORD length = GetEnvironmentVariableW(L"LOCALAPPDATA", logs, ARRAYSIZE(logs));
    if (length == 0 || length >= ARRAYSIZE(logs)) return;
    wcscat_s(logs, ARRAYSIZE(logs), L"\\WELPlatform\\logs");
    make_path(search, ARRAYSIZE(search), logs, L"*.log");
    find = FindFirstFileW(search, &data);
    if (find == INVALID_HANDLE_VALUE) return;
    do {
        if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
        if (count < ARRAYSIZE(candidates)) {
            wcsncpy_s(candidates[count].name, ARRAYSIZE(candidates[count].name), data.cFileName, _TRUNCATE);
            candidates[count].modified = data.ftLastWriteTime;
            ++count;
        }
    } while (FindNextFileW(find, &data));
    FindClose(find);
    for (index = 0; index < count; ++index) {
        DWORD inner;
        for (inner = index + 1; inner < count; ++inner) {
            if (CompareFileTime(&candidates[inner].modified, &candidates[index].modified) > 0) {
                log_candidate temporary = candidates[index];
                candidates[index] = candidates[inner];
                candidates[inner] = temporary;
            }
        }
    }
    if (count > 12) count = 12;
    for (index = 0; index < count; ++index) {
        wchar_t source[MAX_CAPTURE_PATH];
        wchar_t destination[MAX_CAPTURE_PATH];
        make_path(source, ARRAYSIZE(source), logs, candidates[index].name);
        _snwprintf_s(destination, ARRAYSIZE(destination), _TRUNCATE, L"%ls\\wel-log-%02lu-%ls", g_session.work_directory,
            (unsigned long)(index + 1), candidates[index].name);
        CopyFileW(source, destination, FALSE);
    }
}

static void initialize_crc(void) {
    DWORD index;
    for (index = 0; index < 256; ++index) {
        DWORD value = index;
        DWORD bit;
        for (bit = 0; bit < 8; ++bit) value = (value & 1) ? (value >> 1) ^ 0xedb88320UL : value >> 1;
        g_crc_table[index] = value;
    }
}

static DWORD crc_file(FILE *file) {
    unsigned char buffer[32768];
    size_t read;
    DWORD crc = 0xffffffffUL;
    while ((read = fread(buffer, 1, sizeof(buffer), file)) > 0) {
        size_t index;
        for (index = 0; index < read; ++index) crc = g_crc_table[(crc ^ buffer[index]) & 0xff] ^ (crc >> 8);
    }
    return crc ^ 0xffffffffUL;
}

static void zip_u16(FILE *file, WORD value) { fputc(value & 0xff, file); fputc((value >> 8) & 0xff, file); }
static void zip_u32(FILE *file, DWORD value) { zip_u16(file, (WORD)value); zip_u16(file, (WORD)(value >> 16)); }

static int zip_add_file(FILE *zip, const wchar_t *directory, const wchar_t *name, zip_entry *entry) {
    wchar_t source[MAX_CAPTURE_PATH];
    LARGE_INTEGER size;
    WIN32_FILE_ATTRIBUTE_DATA attributes;
    FILE *input;
    unsigned char buffer[32768];
    size_t read;
    FILETIME local_time;
    SYSTEMTIME time;
    int name_length;
    make_path(source, ARRAYSIZE(source), directory, name);
    if (!GetFileAttributesExW(source, GetFileExInfoStandard, &attributes) || attributes.nFileSizeHigh != 0) return 0;
    size.HighPart = attributes.nFileSizeHigh;
    size.LowPart = attributes.nFileSizeLow;
    input = _wfopen(source, L"rb");
    if (input == NULL) return 0;
    entry->crc = crc_file(input);
    fclose(input);
    name_length = WideCharToMultiByte(CP_UTF8, 0, name, -1, entry->name, sizeof(entry->name) - 1, NULL, NULL);
    if (name_length <= 1) return 0;
    --name_length;
    FileTimeToLocalFileTime(&attributes.ftLastWriteTime, &local_time);
    FileTimeToSystemTime(&local_time, &time);
    entry->time = (WORD)((time.wHour << 11) | (time.wMinute << 5) | (time.wSecond / 2));
    entry->date = (WORD)(((time.wYear - 1980) << 9) | (time.wMonth << 5) | time.wDay);
    entry->size = size.LowPart;
    entry->offset = (DWORD)ftell(zip);
    zip_u32(zip, 0x04034b50UL); zip_u16(zip, 20); zip_u16(zip, 0x0800); zip_u16(zip, 0); zip_u16(zip, entry->time); zip_u16(zip, entry->date);
    zip_u32(zip, entry->crc); zip_u32(zip, entry->size); zip_u32(zip, entry->size); zip_u16(zip, (WORD)name_length); zip_u16(zip, 0);
    fwrite(entry->name, 1, (size_t)name_length, zip);
    input = _wfopen(source, L"rb");
    if (input == NULL) return 0;
    while ((read = fread(buffer, 1, sizeof(buffer), input)) > 0) fwrite(buffer, 1, read, zip);
    fclose(input);
    return 1;
}

static int create_archive(void) {
    wchar_t search[MAX_CAPTURE_PATH];
    wchar_t name[MAX_PATH];
    WIN32_FIND_DATAW data;
    HANDLE find;
    FILE *zip;
    zip_entry entries[MAX_ZIP_ENTRIES];
    DWORD count = 0;
    DWORD central_offset;
    DWORD central_size;
    DWORD index;
    SYSTEMTIME now;
    zip = _wfopen(g_session.output_file, L"wb");
    if (zip == NULL) return 0;
    initialize_crc();
    make_path(search, ARRAYSIZE(search), g_session.work_directory, L"*");
    find = FindFirstFileW(search, &data);
    if (find != INVALID_HANDLE_VALUE) {
        do {
            if (data.dwFileAttributes & FILE_ATTRIBUTE_DIRECTORY) continue;
            if (count >= MAX_ZIP_ENTRIES) break;
            wcsncpy_s(name, ARRAYSIZE(name), data.cFileName, _TRUNCATE);
            if (zip_add_file(zip, g_session.work_directory, name, &entries[count])) ++count;
        } while (FindNextFileW(find, &data));
        FindClose(find);
    }
    central_offset = (DWORD)ftell(zip);
    for (index = 0; index < count; ++index) {
        size_t name_length = strlen(entries[index].name);
        zip_u32(zip, 0x02014b50UL); zip_u16(zip, 20); zip_u16(zip, 20); zip_u16(zip, 0x0800); zip_u16(zip, 0);
        zip_u16(zip, entries[index].time); zip_u16(zip, entries[index].date); zip_u32(zip, entries[index].crc);
        zip_u32(zip, entries[index].size); zip_u32(zip, entries[index].size); zip_u16(zip, (WORD)name_length);
        zip_u16(zip, 0); zip_u16(zip, 0); zip_u16(zip, 0); zip_u16(zip, 0); zip_u32(zip, 0); zip_u32(zip, entries[index].offset);
        fwrite(entries[index].name, 1, name_length, zip);
    }
    central_size = (DWORD)ftell(zip) - central_offset;
    GetLocalTime(&now);
    zip_u32(zip, 0x06054b50UL); zip_u16(zip, 0); zip_u16(zip, 0); zip_u16(zip, (WORD)count); zip_u16(zip, (WORD)count);
    zip_u32(zip, central_size); zip_u32(zip, central_offset); zip_u16(zip, 0);
    fclose(zip);
    return count > 0;
}

static int start_packet_capture(void) {
    wchar_t log[MAX_CAPTURE_PATH];
    wchar_t command[MAX_CAPTURE_PATH + 256];
    DWORD result;
    make_path(g_session.etl_file, ARRAYSIZE(g_session.etl_file), g_session.work_directory, L"packets.etl");
    DeleteFileW(g_session.etl_file);
    locate_command(L"pktmon.exe", g_session.pktmon_path, ARRAYSIZE(g_session.pktmon_path));
    locate_command(L"netsh.exe", g_session.netsh_path, ARRAYSIZE(g_session.netsh_path));
    if (g_session.pktmon_path[0] != L'\0') {
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE, L"\"%ls\" stop", g_session.pktmon_path);
        make_path(log, ARRAYSIZE(log), g_session.work_directory, L"pktmon-stop-before.txt");
        run_command(command, g_session.work_directory, log, 10000);
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE, L"\"%ls\" filter remove", g_session.pktmon_path);
        make_path(log, ARRAYSIZE(log), g_session.work_directory, L"pktmon-filter-reset.txt");
        run_command(command, g_session.work_directory, log, 10000);
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE, L"\"%ls\" reset", g_session.pktmon_path);
        make_path(log, ARRAYSIZE(log), g_session.work_directory, L"pktmon-reset.txt");
        run_command(command, g_session.work_directory, log, 10000);
        // Win11: ensure PktMon kernel driver is loadable before we ask pktmon to start.
        run_snapshot_command(L"pktmon-service-check.txt", L"sc.exe query PktMon");
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE, L"\"%ls\" start --capture --pkt-size 0 --file-name \"%ls\"", g_session.pktmon_path, g_session.etl_file);
        make_path(log, ARRAYSIZE(log), g_session.work_directory, L"pktmon-start.txt");
        result = run_command(command, g_session.work_directory, log, 30000);
        if (result == 0) { g_session.mode = CAPTURE_PKTMON; return 1; }
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE, L"\"%ls\" start --capture --file-name \"%ls\"", g_session.pktmon_path, g_session.etl_file);
        make_path(log, ARRAYSIZE(log), g_session.work_directory, L"pktmon-start-fallback.txt");
        result = run_command(command, g_session.work_directory, log, 30000);
        if (result == 0) { g_session.mode = CAPTURE_PKTMON; return 1; }
        {
            wchar_t detail[1536];
            read_log_tail(L"pktmon-start.txt", detail, ARRAYSIZE(detail));
            if (detail[0] == L'\0') read_log_tail(L"pktmon-start-fallback.txt", detail, ARRAYSIZE(detail));
            post_status(L"pktmon start failed (code %lu): %ls", (unsigned long)result,
                detail[0] != L'\0' ? detail : L"(no output; pktmon usually requires Administrator rights)");
        }
    } else {
        post_status(L"pktmon.exe was not found.");
    }
    if (g_session.netsh_path[0] != L'\0') {
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE, L"\"%ls\" trace stop", g_session.netsh_path);
        make_path(log, ARRAYSIZE(log), g_session.work_directory, L"netsh-stop-before.txt");
        run_command(command, g_session.work_directory, log, 10000);
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE,
            L"\"%ls\" trace start capture=yes persistent=no overwrite=yes maxsize=512 correlation=yes tracefile=\"%ls\"", g_session.netsh_path, g_session.etl_file);
        make_path(log, ARRAYSIZE(log), g_session.work_directory, L"netsh-start.txt");
        result = run_command(command, g_session.work_directory, log, 30000);
        if (result == 0) { g_session.mode = CAPTURE_NETSH; return 1; }
        {
            wchar_t detail[1536];
            read_log_tail(L"netsh-start.txt", detail, ARRAYSIZE(detail));
            post_status(L"Windows trace fallback failed (code %lu): %ls", (unsigned long)result,
                detail[0] != L'\0' ? detail : L"(no output; netsh trace requires Administrator rights)");
        }
    } else {
        post_status(L"netsh.exe was not found.");
    }
    post_status(L"No usable Windows packet capture session could be started.");
    post_status(L"Win11 hint: open an elevated cmd and run 'sc.exe config PktMon start= demand' then 'sc.exe start PktMon', and make sure no 3rd party antivirus (360 / Tencent PC Manager) or Smart App Control is blocking the PktMon driver. The WELCapture folder on the Desktop was kept for inspection.");
    return 0;
}

static void stop_packet_capture(void) {
    wchar_t log[MAX_CAPTURE_PATH];
    wchar_t conversion_log[MAX_CAPTURE_PATH];
    wchar_t command[MAX_CAPTURE_PATH + 256];
    make_path(log, ARRAYSIZE(log), g_session.work_directory, L"capture-stop.txt");
    if (g_session.mode == CAPTURE_PKTMON) {
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE, L"\"%ls\" stop", g_session.pktmon_path);
        run_command(command, g_session.work_directory, log, 60000);
        make_path(conversion_log, ARRAYSIZE(conversion_log), g_session.work_directory, L"capture-text-convert.txt");
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE, L"\"%ls\" etl2txt \"%ls\" -o \"%ls\\packets.txt\"", g_session.pktmon_path, g_session.etl_file, g_session.work_directory);
        run_command(command, g_session.work_directory, conversion_log, 60000);
        make_path(conversion_log, ARRAYSIZE(conversion_log), g_session.work_directory, L"capture-pcap-convert.txt");
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE, L"\"%ls\" etl2pcap \"%ls\" -o \"%ls\\packets.pcapng\"", g_session.pktmon_path, g_session.etl_file, g_session.work_directory);
        if (run_command(command, g_session.work_directory, conversion_log, 60000) != 0) {
            _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE, L"\"%ls\" etl2pcap \"%ls\" --out \"%ls\\packets.pcapng\"", g_session.pktmon_path, g_session.etl_file, g_session.work_directory);
            run_command(command, g_session.work_directory, conversion_log, 60000);
        }
    } else if (g_session.netsh_path[0] != L'\0') {
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE, L"\"%ls\" trace stop", g_session.netsh_path);
        run_command(command, g_session.work_directory, log, 60000);
    }
}

static DWORD WINAPI start_capture_thread(LPVOID unused) {
    wchar_t desktop[MAX_CAPTURE_PATH];
    SYSTEMTIME now;
    HANDLE timeline;
    (void)unused;
    GetLocalTime(&now);
    if (SHGetFolderPathW(NULL, CSIDL_DESKTOPDIRECTORY, NULL, SHGFP_TYPE_CURRENT, desktop) != S_OK) {
        PostMessageW(g_main_window, WM_CAPTURE_FAILED, 0, 0); return 0;
    }
    _snwprintf_s(g_session.work_directory, ARRAYSIZE(g_session.work_directory), _TRUNCATE, L"%ls\\WELCapture-%ls-%04u%02u%02u-%02u%02u%02u",
        desktop, g_session.role, now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond);
    _snwprintf_s(g_session.output_file, ARRAYSIZE(g_session.output_file), _TRUNCATE, L"%ls\\WEL网络诊断-%ls-%04u%02u%02u-%02u%02u%02u.welcap.zip",
        desktop, g_session.role, now.wYear, now.wMonth, now.wDay, now.wHour, now.wMinute, now.wSecond);
    if (!ensure_directory(g_session.work_directory)) { PostMessageW(g_main_window, WM_CAPTURE_FAILED, 0, 0); return 0; }
    post_status(L"Collecting initial network state...");
    collect_snapshot(L"start");
    if (!start_packet_capture()) { PostMessageW(g_main_window, WM_CAPTURE_FAILED, 0, 0); return 0; }
    GetSystemTimeAsFileTime(&g_session.started);
    write_capture_info(L"capture started");
    InterlockedExchange(&g_state, CAPTURE_RUNNING);
    timeline = CreateThread(NULL, 0, timeline_thread, NULL, 0, NULL);
    if (timeline != NULL) CloseHandle(timeline);
    PostMessageW(g_main_window, WM_CAPTURE_READY, 0, 0);
    return 0;
}

static DWORD WINAPI stop_capture_thread(LPVOID unused) {
    (void)unused;
    post_status(L"Stopping packet capture...");
    stop_packet_capture();
    append_game_timeline();
    post_status(L"Collecting final network state...");
    collect_snapshot(L"end");
    copy_wel_logs();
    write_capture_info(L"capture stopped");
    post_status(L"Creating single diagnostic archive...");
    if (create_archive()) PostMessageW(g_main_window, WM_CAPTURE_DONE, 0, 0);
    else PostMessageW(g_main_window, WM_CAPTURE_FAILED, 0, 0);
    return 0;
}

static void start_capture(void) {
    int selection;
    if (InterlockedCompareExchange(&g_state, CAPTURE_STARTING, CAPTURE_IDLE) != CAPTURE_IDLE) return;
    selection = (int)SendMessageW(g_role, CB_GETCURSEL, 0, 0);
    wcscpy_s(g_session.role, ARRAYSIZE(g_session.role), selection == 1 ? L"Client-B" : L"Host-A");
    SetWindowTextW(g_status, L"");
    EnableWindow(g_start_button, FALSE);
    EnableWindow(g_stop_button, FALSE);
    EnableWindow(g_open_button, FALSE);
    post_status(L"Preparing capture. Start the game only after status changes to Capturing.");
    if (CreateThread(NULL, 0, start_capture_thread, NULL, 0, NULL) == NULL) {
        InterlockedExchange(&g_state, CAPTURE_IDLE);
        EnableWindow(g_start_button, TRUE);
    }
}

static void stop_capture(void) {
    if (InterlockedCompareExchange(&g_state, CAPTURE_STOPPING, CAPTURE_RUNNING) != CAPTURE_RUNNING) return;
    EnableWindow(g_stop_button, FALSE);
    if (CreateThread(NULL, 0, stop_capture_thread, NULL, 0, NULL) == NULL) {
        InterlockedExchange(&g_state, CAPTURE_RUNNING);
        EnableWindow(g_stop_button, TRUE);
    }
}

static void open_output(void) {
    wchar_t arguments[MAX_CAPTURE_PATH + 32];
    _snwprintf_s(arguments, ARRAYSIZE(arguments), _TRUNCATE, L"/select,\"%ls\"", g_session.output_file);
    ShellExecuteW(g_main_window, L"open", L"explorer.exe", arguments, NULL, SW_SHOWNORMAL);
}

static LRESULT CALLBACK window_proc(HWND window, UINT message, WPARAM wparam, LPARAM lparam) {
    switch (message) {
    case WM_COMMAND:
        if (LOWORD(wparam) == ID_START) start_capture();
        else if (LOWORD(wparam) == ID_STOP) stop_capture();
        else if (LOWORD(wparam) == ID_OPEN) open_output();
        return 0;
    case WM_STATUS:
        append_status((const wchar_t *)lparam);
        HeapFree(GetProcessHeap(), 0, (void *)lparam);
        return 0;
    case WM_CAPTURE_READY:
        append_status(L"Capturing. Open WE8 now, complete the host/client session, then stop capture.");
        EnableWindow(g_stop_button, TRUE);
        return 0;
    case WM_CAPTURE_DONE:
        InterlockedExchange(&g_state, CAPTURE_IDLE);
        append_status(L"Finished. One .welcap.zip file was created on the Desktop.");
        EnableWindow(g_start_button, TRUE);
        EnableWindow(g_open_button, TRUE);
        MessageBoxW(window, L"抓包完成，桌面已生成一个 .welcap.zip 文件。", L"WEL 网络诊断", MB_OK | MB_ICONINFORMATION);
        return 0;
    case WM_CAPTURE_FAILED:
        InterlockedExchange(&g_state, CAPTURE_IDLE);
        append_status(L"Capture failed. The working folder on the Desktop was kept for inspection.");
        EnableWindow(g_start_button, TRUE);
        {
            wchar_t status_text[4096];
            wchar_t *tail = status_text;
            GetWindowTextW(g_status, status_text, ARRAYSIZE(status_text));
            if (wcslen(status_text) > 1200) tail = status_text + wcslen(status_text) - 1200;
            MessageBoxW(window, tail, L"WEL 网络诊断 - 抓包失败原因", MB_OK | MB_ICONERROR);
        }
        return 0;
    case WM_CLOSE:
        if (g_state == CAPTURE_RUNNING) {
            MessageBoxW(window, L"请先点击“结束并生成文件”，避免留下未停止的系统抓包。", L"WEL 网络诊断", MB_OK | MB_ICONWARNING);
            return 0;
        }
        if (g_state != CAPTURE_IDLE) return 0;
        DestroyWindow(window);
        return 0;
    case WM_DESTROY:
        PostQuitMessage(0);
        return 0;
    }
    return DefWindowProcW(window, message, wparam, lparam);
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show) {
    WNDCLASSW window_class;
    MSG message;
    HFONT font;
    (void)previous; (void)command_line;
    ZeroMemory(&window_class, sizeof(window_class));
    window_class.hInstance = instance;
    window_class.hCursor = LoadCursor(NULL, IDC_ARROW);
    window_class.hbrBackground = (HBRUSH)(COLOR_WINDOW + 1);
    window_class.lpfnWndProc = window_proc;
    window_class.lpszClassName = L"WELPacketCapture";
    if (!RegisterClassW(&window_class)) return 1;
    g_main_window = CreateWindowExW(0, window_class.lpszClassName, L"WEL 网络诊断工具", WS_OVERLAPPED | WS_CAPTION | WS_SYSMENU | WS_MINIMIZEBOX,
        CW_USEDEFAULT, CW_USEDEFAULT, 690, 390, NULL, NULL, instance, NULL);
    if (g_main_window == NULL) return 1;
    font = (HFONT)GetStockObject(DEFAULT_GUI_FONT);
    CreateWindowW(L"STATIC", L"测试角色：", WS_CHILD | WS_VISIBLE, 20, 20, 80, 24, g_main_window, NULL, instance, NULL);
    g_role = CreateWindowW(L"COMBOBOX", L"", WS_CHILD | WS_VISIBLE | CBS_DROPDOWNLIST, 100, 17, 150, 180, g_main_window, (HMENU)ID_ROLE, instance, NULL);
    SendMessageW(g_role, CB_ADDSTRING, 0, (LPARAM)L"主机 A");
    SendMessageW(g_role, CB_ADDSTRING, 0, (LPARAM)L"客机 B");
    SendMessageW(g_role, CB_SETCURSEL, 0, 0);
    g_start_button = CreateWindowW(L"BUTTON", L"开始抓包", WS_CHILD | WS_VISIBLE | BS_DEFPUSHBUTTON, 280, 16, 120, 30, g_main_window, (HMENU)ID_START, instance, NULL);
    g_stop_button = CreateWindowW(L"BUTTON", L"结束并生成文件", WS_CHILD | WS_VISIBLE, 410, 16, 140, 30, g_main_window, (HMENU)ID_STOP, instance, NULL);
    g_open_button = CreateWindowW(L"BUTTON", L"打开文件位置", WS_CHILD | WS_VISIBLE, 560, 16, 110, 30, g_main_window, (HMENU)ID_OPEN, instance, NULL);
    g_status = CreateWindowExW(WS_EX_CLIENTEDGE, L"EDIT", L"", WS_CHILD | WS_VISIBLE | ES_MULTILINE | ES_READONLY | ES_AUTOVSCROLL | WS_VSCROLL,
        20, 65, 650, 270, g_main_window, NULL, instance, NULL);
    SendMessageW(g_role, WM_SETFONT, (WPARAM)font, TRUE);
    SendMessageW(g_start_button, WM_SETFONT, (WPARAM)font, TRUE);
    SendMessageW(g_stop_button, WM_SETFONT, (WPARAM)font, TRUE);
    SendMessageW(g_open_button, WM_SETFONT, (WPARAM)font, TRUE);
    SendMessageW(g_status, WM_SETFONT, (WPARAM)font, TRUE);
    EnableWindow(g_stop_button, FALSE);
    EnableWindow(g_open_button, FALSE);
    ShowWindow(g_main_window, show);
    UpdateWindow(g_main_window);
    append_status(L"Choose Host A or Client B. Both computers should start capture before opening WE8.");
    while (GetMessageW(&message, NULL, 0, 0) > 0) { TranslateMessage(&message); DispatchMessageW(&message); }
    return 0;
}
