#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601

#include <windows.h>
#include <shellapi.h>
#include <wchar.h>

#define WEL_FIREWALL_SUCCESS 0
#define WEL_FIREWALL_INVALID_ARGUMENTS 2
#define WEL_FIREWALL_UAC_CANCELLED 10
#define WEL_FIREWALL_ELEVATION_FAILED 11
#define WEL_FIREWALL_NETSH_FAILED 12

typedef struct {
    const wchar_t *subnet;
    const wchar_t *edge_path;
    int elevated;
    int self_test;
} wel_firewall_options;

static int valid_subnet(const wchar_t *value) {
    const wchar_t *cursor = value;
    if (value == NULL || *value == L'\0') return 0;
    while (*cursor != L'\0') {
        if (!((*cursor >= L'0' && *cursor <= L'9') || *cursor == L'.' || *cursor == L'/')) return 0;
        ++cursor;
    }
    return 1;
}

static int parse_options(int argc, wchar_t **argv, wel_firewall_options *options) {
    int index;
    ZeroMemory(options, sizeof(*options));
    for (index = 1; index < argc; ++index) {
        if (wcscmp(argv[index], L"--elevated") == 0) options->elevated = 1;
        else if (wcscmp(argv[index], L"--self-test") == 0) options->self_test = 1;
        else if (wcscmp(argv[index], L"--subnet") == 0 && index + 1 < argc) options->subnet = argv[++index];
        else if (wcscmp(argv[index], L"--edge") == 0 && index + 1 < argc) options->edge_path = argv[++index];
        else return 0;
    }
    if (options->self_test) return 1;
    return valid_subnet(options->subnet) && options->edge_path != NULL && *options->edge_path != L'\0';
}

static int run_netsh(const wchar_t *arguments) {
    wchar_t system_directory[MAX_PATH];
    wchar_t command_line[4096];
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    DWORD exit_code = 1;

    if (GetSystemDirectoryW(system_directory, ARRAYSIZE(system_directory)) == 0) return 0;
    if (_snwprintf_s(command_line, ARRAYSIZE(command_line), _TRUNCATE,
        L"\"%ls\\netsh.exe\" %ls", system_directory, arguments) < 0) return 0;

    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup);
    startup.dwFlags = STARTF_USESHOWWINDOW;
    startup.wShowWindow = SW_HIDE;
    if (!CreateProcessW(NULL, command_line, NULL, NULL, FALSE, CREATE_NO_WINDOW,
        NULL, NULL, &startup, &process)) return 0;
    if (WaitForSingleObject(process.hProcess, 15000) != WAIT_OBJECT_0) {
        TerminateProcess(process.hProcess, 1);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return 0;
    }
    GetExitCodeProcess(process.hProcess, &exit_code);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return exit_code == 0;
}

static int add_room_rules(const wel_firewall_options *options) {
    wchar_t command[4096];
    const wchar_t *remove_rules[] = {
        L"WEL game discovery UDP 5739 inbound",
        L"WEL room UDP inbound",
        L"WEL room UDP outbound",
        L"WEL room ICMPv4 inbound",
        L"WEL room ICMPv4 outbound",
        L"WEL n2n edge inbound"
    };
    size_t index;

    for (index = 0; index < ARRAYSIZE(remove_rules); ++index) {
        _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE,
            L"advfirewall firewall delete rule name=\"%ls\"", remove_rules[index]);
        run_netsh(command);
    }

    _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE,
        L"advfirewall firewall add rule name=\"WEL n2n edge inbound\" dir=in action=allow program=\"%ls\" enable=yes profile=any",
        options->edge_path);
    if (!run_netsh(command)) return 0;

    _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE,
        L"advfirewall firewall add rule name=\"WEL room UDP inbound\" dir=in action=allow protocol=udp remoteip=%ls enable=yes profile=any",
        options->subnet);
    if (!run_netsh(command)) return 0;

    _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE,
        L"advfirewall firewall add rule name=\"WEL room UDP outbound\" dir=out action=allow protocol=udp remoteip=%ls enable=yes profile=any",
        options->subnet);
    if (!run_netsh(command)) return 0;

    _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE,
        L"advfirewall firewall add rule name=\"WEL room ICMPv4 inbound\" dir=in action=allow protocol=icmpv4:any,any remoteip=%ls enable=yes profile=any",
        options->subnet);
    if (!run_netsh(command)) return 0;

    _snwprintf_s(command, ARRAYSIZE(command), _TRUNCATE,
        L"advfirewall firewall add rule name=\"WEL room ICMPv4 outbound\" dir=out action=allow protocol=icmpv4:any,any remoteip=%ls enable=yes profile=any",
        options->subnet);
    return run_netsh(command);
}

static int elevate_self(const wel_firewall_options *options) {
    wchar_t executable[MAX_PATH];
    wchar_t parameters[4096];
    SHELLEXECUTEINFOW execute;
    DWORD exit_code = WEL_FIREWALL_ELEVATION_FAILED;

    if (GetModuleFileNameW(NULL, executable, ARRAYSIZE(executable)) == 0) return WEL_FIREWALL_ELEVATION_FAILED;
    if (_snwprintf_s(parameters, ARRAYSIZE(parameters), _TRUNCATE,
        L"--elevated --subnet \"%ls\" --edge \"%ls\"", options->subnet, options->edge_path) < 0) {
        return WEL_FIREWALL_INVALID_ARGUMENTS;
    }

    ZeroMemory(&execute, sizeof(execute));
    execute.cbSize = sizeof(execute);
    execute.fMask = SEE_MASK_NOCLOSEPROCESS;
    execute.lpVerb = L"runas";
    execute.lpFile = executable;
    execute.lpParameters = parameters;
    execute.nShow = SW_HIDE;
    if (!ShellExecuteExW(&execute)) {
        return GetLastError() == ERROR_CANCELLED ? WEL_FIREWALL_UAC_CANCELLED : WEL_FIREWALL_ELEVATION_FAILED;
    }
    if (execute.hProcess == NULL) return WEL_FIREWALL_ELEVATION_FAILED;
    if (WaitForSingleObject(execute.hProcess, 30000) != WAIT_OBJECT_0) {
        CloseHandle(execute.hProcess);
        return WEL_FIREWALL_ELEVATION_FAILED;
    }
    GetExitCodeProcess(execute.hProcess, &exit_code);
    CloseHandle(execute.hProcess);
    return (int)exit_code;
}

int WINAPI wWinMain(HINSTANCE instance, HINSTANCE previous, PWSTR command_line, int show_command) {
    int argc = 0;
    wchar_t **argv = CommandLineToArgvW(GetCommandLineW(), &argc);
    wel_firewall_options options;
    int result;
    (void)instance;
    (void)previous;
    (void)command_line;
    (void)show_command;

    if (argv == NULL) return WEL_FIREWALL_INVALID_ARGUMENTS;
    if (!parse_options(argc, argv, &options)) {
        LocalFree(argv);
        return WEL_FIREWALL_INVALID_ARGUMENTS;
    }
    if (options.self_test) {
        LocalFree(argv);
        return WEL_FIREWALL_SUCCESS;
    }
    result = options.elevated ? (add_room_rules(&options) ? WEL_FIREWALL_SUCCESS : WEL_FIREWALL_NETSH_FAILED)
        : elevate_self(&options);
    LocalFree(argv);
    return result;
}
