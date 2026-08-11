#define WIN32_LEAN_AND_MEAN
#define _WIN32_WINNT 0x0601

#include <windows.h>
#include <stdio.h>
#include <wchar.h>

typedef struct {
    const wchar_t *game_path;
    const wchar_t *hook_path;
    const wchar_t *local_port;
    int self_test;
} wel_relay_launch_options;

static int parse_options(int argc, wchar_t **argv, wel_relay_launch_options *options) {
    int index;
    ZeroMemory(options, sizeof(*options));
    for (index = 1; index < argc; ++index) {
        if (wcscmp(argv[index], L"--self-test") == 0) options->self_test = 1;
        else if (wcscmp(argv[index], L"--game") == 0 && index + 1 < argc) options->game_path = argv[++index];
        else if (wcscmp(argv[index], L"--hook") == 0 && index + 1 < argc) options->hook_path = argv[++index];
        else if (wcscmp(argv[index], L"--local-port") == 0 && index + 1 < argc) options->local_port = argv[++index];
        else return 0;
    }
    if (options->self_test) return 1;
    return options->game_path != NULL && options->hook_path != NULL && options->local_port != NULL;
}

static wchar_t *quoted_command_line(const wchar_t *game_path) {
    size_t length = wcslen(game_path);
    wchar_t *command_line = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (length + 3) * sizeof(wchar_t));
    if (command_line == NULL) return NULL;
    command_line[0] = L'"';
    CopyMemory(command_line + 1, game_path, length * sizeof(wchar_t));
    command_line[length + 1] = L'"';
    return command_line;
}

static wchar_t *game_directory(const wchar_t *game_path) {
    size_t length = wcslen(game_path);
    wchar_t *directory = (wchar_t *)HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, (length + 1) * sizeof(wchar_t));
    wchar_t *separator;
    if (directory == NULL) return NULL;
    CopyMemory(directory, game_path, (length + 1) * sizeof(wchar_t));
    separator = wcsrchr(directory, L'\\');
    if (separator == NULL) separator = wcsrchr(directory, L'/');
    if (separator != NULL) *separator = L'\0';
    return directory;
}

static int inject_hook(HANDLE process, const wchar_t *hook_path) {
    SIZE_T path_size = (wcslen(hook_path) + 1) * sizeof(wchar_t);
    LPVOID remote_path = VirtualAllocEx(process, NULL, path_size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE);
    HMODULE kernel32;
    FARPROC load_library;
    HANDLE thread;
    DWORD module_handle = 0;
    if (remote_path == NULL) return 0;
    if (!WriteProcessMemory(process, remote_path, hook_path, path_size, NULL)) { VirtualFreeEx(process, remote_path, 0, MEM_RELEASE); return 0; }
    kernel32 = GetModuleHandleW(L"kernel32.dll");
    load_library = kernel32 == NULL ? NULL : GetProcAddress(kernel32, "LoadLibraryW");
    if (load_library == NULL) { VirtualFreeEx(process, remote_path, 0, MEM_RELEASE); return 0; }
    thread = CreateRemoteThread(process, NULL, 0, (LPTHREAD_START_ROUTINE)load_library, remote_path, 0, NULL);
    if (thread == NULL) { VirtualFreeEx(process, remote_path, 0, MEM_RELEASE); return 0; }
    if (WaitForSingleObject(thread, 10000) == WAIT_OBJECT_0) GetExitCodeThread(thread, &module_handle);
    CloseHandle(thread);
    VirtualFreeEx(process, remote_path, 0, MEM_RELEASE);
    return module_handle != 0;
}

int wmain(int argc, wchar_t **argv) {
    wel_relay_launch_options options;
    STARTUPINFOW startup;
    PROCESS_INFORMATION process;
    wchar_t full_game_path[MAX_PATH];
    wchar_t full_hook_path[MAX_PATH];
    wchar_t *command_line;
    wchar_t *working_directory;
    wchar_t ready_event_name[96];
    HANDLE ready_event;
    if (!parse_options(argc, argv, &options)) {
        fwprintf(stderr, L"Usage: welrelaygame.exe --game <path> --hook <path> --local-port <port>\n");
        return 2;
    }
    if (options.self_test) { puts("SELF-TEST OK"); return 0; }
    if (GetFullPathNameW(options.game_path, ARRAYSIZE(full_game_path), full_game_path, NULL) == 0 || GetFileAttributesW(full_game_path) == INVALID_FILE_ATTRIBUTES) {
        fwprintf(stderr, L"Game executable not found: %ls\n", options.game_path);
        return 3;
    }
    if (GetFullPathNameW(options.hook_path, ARRAYSIZE(full_hook_path), full_hook_path, NULL) == 0 || GetFileAttributesW(full_hook_path) == INVALID_FILE_ATTRIBUTES) {
        fwprintf(stderr, L"Plan B game network module not found: %ls\n", options.hook_path);
        return 4;
    }
    if (!SetEnvironmentVariableW(L"WEL_RELAY_LOCAL_PORT", options.local_port)) return 5;
    _snwprintf_s(ready_event_name, ARRAYSIZE(ready_event_name), _TRUNCATE, L"Local\\WELRelayHookReady-%lu-%lu",
        (unsigned long)GetCurrentProcessId(), (unsigned long)GetTickCount());
    ready_event = CreateEventW(NULL, TRUE, FALSE, ready_event_name);
    if (ready_event == NULL || !SetEnvironmentVariableW(L"WEL_HOOK_READY_EVENT", ready_event_name)) return 5;
    command_line = quoted_command_line(full_game_path);
    working_directory = game_directory(full_game_path);
    if (command_line == NULL || working_directory == NULL) return 5;
    ZeroMemory(&startup, sizeof(startup));
    ZeroMemory(&process, sizeof(process));
    startup.cb = sizeof(startup);
    if (!CreateProcessW(full_game_path, command_line, NULL, NULL, FALSE, CREATE_SUSPENDED | CREATE_DEFAULT_ERROR_MODE,
        NULL, working_directory, &startup, &process)) {
        fwprintf(stderr, L"CreateProcess failed: Windows error %lu\n", GetLastError());
        return 6;
    }
    HeapFree(GetProcessHeap(), 0, command_line);
    HeapFree(GetProcessHeap(), 0, working_directory);
    if (!inject_hook(process.hProcess, full_hook_path)) {
        TerminateProcess(process.hProcess, 7);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return 7;
    }
    if (WaitForSingleObject(ready_event, 5000) != WAIT_OBJECT_0) {
        TerminateProcess(process.hProcess, 8);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return 8;
    }
    CloseHandle(ready_event);
    if (ResumeThread(process.hThread) == (DWORD)-1) {
        TerminateProcess(process.hProcess, 9);
        CloseHandle(process.hThread);
        CloseHandle(process.hProcess);
        return 9;
    }
    printf("STARTED pid=%lu\n", (unsigned long)process.dwProcessId);
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
    return 0;
}
