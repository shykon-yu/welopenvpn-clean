#include <windows.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "windivert.h"

#define WEL_PACKET_BUFFER_SIZE 65535
#define WEL_DISCOVERY_FILTER \
    "outbound and ip and udp.DstPort == 5739 and ip.DstAddr == 255.255.255.255"

typedef struct {
    const char *tap_ip_text;
    const char *broadcast_ip_text;
    UINT32 tap_ip;
    UINT32 broadcast_ip;
    UINT32 interface_index;
    int self_test;
} wel_options;

static void print_usage(void) {
    fprintf(stderr,
        "Usage: welnet.exe --tap-ip <IPv4> --broadcast-ip <IPv4> "
        "--interface-index <index>\n");
}

static int parse_uint32(const char *text, UINT32 *value) {
    char *end = NULL;
    unsigned long parsed;

    if (text == NULL || text[0] == '\0') return 0;
    parsed = strtoul(text, &end, 10);
    if (end == text || *end != '\0' || parsed == 0 || parsed > UINT32_MAX) return 0;
    *value = (UINT32)parsed;
    return 1;
}

static int parse_options(int argc, char **argv, wel_options *options) {
    int index;
    memset(options, 0, sizeof(*options));

    for (index = 1; index < argc; index++) {
        if (strcmp(argv[index], "--self-test") == 0) {
            options->self_test = 1;
        } else if (strcmp(argv[index], "--tap-ip") == 0 && index + 1 < argc) {
            options->tap_ip_text = argv[++index];
        } else if (strcmp(argv[index], "--broadcast-ip") == 0 && index + 1 < argc) {
            options->broadcast_ip_text = argv[++index];
        } else if (strcmp(argv[index], "--interface-index") == 0 && index + 1 < argc) {
            if (!parse_uint32(argv[++index], &options->interface_index)) return 0;
        } else {
            return 0;
        }
    }

    if (options->self_test) return 1;
    if (options->tap_ip_text == NULL || options->broadcast_ip_text == NULL ||
        options->interface_index == 0) return 0;
    if (!WinDivertHelperParseIPv4Address(options->tap_ip_text, &options->tap_ip)) return 0;
    if (!WinDivertHelperParseIPv4Address(options->broadcast_ip_text, &options->broadcast_ip)) return 0;
    return 1;
}

static BOOL receive_packet(
    HANDLE handle,
    void *packet,
    UINT packet_capacity,
    UINT *packet_length,
    WINDIVERT_ADDRESS *address
) {
#ifdef WEL_WINDIVERT_V2
    return WinDivertRecv(handle, packet, packet_capacity, packet_length, address);
#else
    return WinDivertRecv(handle, packet, packet_capacity, address, packet_length);
#endif
}

static BOOL send_packet(
    HANDLE handle,
    void *packet,
    UINT packet_length,
    UINT *send_length,
    WINDIVERT_ADDRESS *address
) {
#ifdef WEL_WINDIVERT_V2
    return WinDivertSend(handle, packet, packet_length, send_length, address);
#else
    return WinDivertSend(handle, packet, packet_length, address, send_length);
#endif
}

static void set_output_interface(WINDIVERT_ADDRESS *address, UINT32 interface_index) {
#ifdef WEL_WINDIVERT_V2
    address->Network.IfIdx = interface_index;
    address->Network.SubIfIdx = 0;
#else
    address->IfIdx = interface_index;
    address->SubIfIdx = 0;
#endif
}

int main(int argc, char **argv) {
    wel_options options;
    HANDLE handle;
    unsigned char packet[WEL_PACKET_BUFFER_SIZE];

    if (!parse_options(argc, argv, &options)) {
        print_usage();
        return 2;
    }
    if (options.self_test) {
        UINT32 parsed = 0;
        if (!WinDivertHelperParseIPv4Address("10.222.1.10", &parsed)) return 3;
        puts("SELF-TEST OK");
        return 0;
    }

    handle = WinDivertOpen(WEL_DISCOVERY_FILTER, WINDIVERT_LAYER_NETWORK, 0, 0);
    if (handle == INVALID_HANDLE_VALUE) {
        fprintf(stderr, "WinDivertOpen failed: Windows error %lu\n", GetLastError());
        return 4;
    }

    printf("READY tap=%s broadcast=%s interface=%lu\n",
        options.tap_ip_text,
        options.broadcast_ip_text,
        (unsigned long)options.interface_index);
    fflush(stdout);

    for (;;) {
        WINDIVERT_ADDRESS address;
        WINDIVERT_IPHDR *ip_header;
        UINT packet_length = 0;
        UINT send_length = 0;

        memset(&address, 0, sizeof(address));
        if (!receive_packet(handle, packet, sizeof(packet), &packet_length, &address)) {
            fprintf(stderr, "WinDivertRecv failed: Windows error %lu\n", GetLastError());
            WinDivertClose(handle);
            return 5;
        }
        if (packet_length < sizeof(WINDIVERT_IPHDR)) continue;

        ip_header = (WINDIVERT_IPHDR *)packet;
        if (ip_header->Version != 4 || ip_header->Protocol != IPPROTO_UDP) continue;

        ip_header->SrcAddr = options.tap_ip;
        ip_header->DstAddr = options.broadcast_ip;
        set_output_interface(&address, options.interface_index);
        WinDivertHelperCalcChecksums(packet, packet_length, &address, 0);

        if (!send_packet(handle, packet, packet_length, &send_length, &address)) {
            fprintf(stderr, "WinDivertSend failed: Windows error %lu\n", GetLastError());
            WinDivertClose(handle);
            return 6;
        }
    }
}
