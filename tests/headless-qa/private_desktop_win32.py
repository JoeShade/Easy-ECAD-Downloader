"""Win32 boundary for headed QA Chrome, its private desktop and process job.

The launcher forwards the inherited C-runtime descriptor table so Puppeteer's
private debugging pipes (descriptors 3/4) reach Chrome. New windows belong to
the named private desktop; the user's selected input desktop remains intact.
"""
import ctypes
from ctypes import wintypes as w
import subprocess


# These layouts mirror the Windows SDK, including pointer-sized handles and
# alignment. Matching the native layout preserves inherited pipes and job limits.
class StartupInfo(ctypes.Structure):
    _fields_ = [("cb", w.DWORD), ("lpReserved", w.LPWSTR),
                ("lpDesktop", w.LPWSTR), ("lpTitle", w.LPWSTR),
                ("dwX", w.DWORD), ("dwY", w.DWORD),
                ("dwXSize", w.DWORD), ("dwYSize", w.DWORD),
                ("dwXCountChars", w.DWORD), ("dwYCountChars", w.DWORD),
                ("dwFillAttribute", w.DWORD), ("dwFlags", w.DWORD),
                ("wShowWindow", w.WORD), ("cbReserved2", w.WORD),
                ("lpReserved2", ctypes.POINTER(ctypes.c_ubyte)),
                ("hStdInput", w.HANDLE), ("hStdOutput", w.HANDLE), ("hStdError", w.HANDLE)]


class ProcessInfo(ctypes.Structure):
    _fields_ = [("hProcess", w.HANDLE), ("hThread", w.HANDLE),
                ("dwProcessId", w.DWORD), ("dwThreadId", w.DWORD)]


class JobLimits(ctypes.Structure):
    _fields_ = [("user_time", ctypes.c_int64), ("job_time", ctypes.c_int64),
                ("flags", w.DWORD), ("minimum_working_set", ctypes.c_size_t),
                ("maximum_working_set", ctypes.c_size_t), ("active_process_limit", w.DWORD),
                ("affinity", ctypes.c_size_t), ("priority", w.DWORD), ("scheduling", w.DWORD)]


class ExtendedJobLimits(ctypes.Structure):
    _fields_ = [("basic", JobLimits), ("io_counters", ctypes.c_uint64 * 6),
                ("process_memory", ctypes.c_size_t), ("job_memory", ctypes.c_size_t),
                ("peak_process_memory", ctypes.c_size_t), ("peak_job_memory", ctypes.c_size_t)]


class JobAccounting(ctypes.Structure):
    _fields_ = [("times", ctypes.c_int64 * 4), ("page_faults", w.DWORD),
                ("total_processes", w.DWORD), ("active_processes", w.DWORD),
                ("terminated_processes", w.DWORD)]


def checked(value):
    if not value:
        raise ctypes.WinError(ctypes.get_last_error())
    return value


class WindowsDesktop:
    """Bind pointer-sized signatures explicitly; load DLLs only on Windows."""

    def __init__(self):
        self.user = ctypes.WinDLL("user32", use_last_error=True)
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)

        def bind(dll, name, args, result=w.BOOL):
            function = getattr(dll, name)
            function.argtypes, function.restype = args, result

        bind(self.user, "CreateDesktopW", [w.LPCWSTR, w.LPCWSTR, w.LPVOID, w.DWORD, w.DWORD, w.LPVOID], w.HANDLE)
        bind(self.user, "CloseDesktop", [w.HANDLE])
        bind(self.user, "OpenInputDesktop", [w.DWORD, w.BOOL, w.DWORD], w.HANDLE)
        bind(self.user, "GetUserObjectInformationW", [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, ctypes.POINTER(w.DWORD)])
        bind(self.kernel, "GetStartupInfoW", [ctypes.POINTER(StartupInfo)], None)
        bind(self.kernel, "CreateProcessW", [w.LPCWSTR, w.LPWSTR, w.LPVOID, w.LPVOID, w.BOOL,
             w.DWORD, w.LPVOID, w.LPCWSTR, ctypes.POINTER(StartupInfo), ctypes.POINTER(ProcessInfo)])
        bind(self.kernel, "CreateJobObjectW", [w.LPVOID, w.LPCWSTR], w.HANDLE)
        bind(self.kernel, "SetInformationJobObject", [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD])
        bind(self.kernel, "QueryInformationJobObject", [w.HANDLE, ctypes.c_int, w.LPVOID, w.DWORD, w.LPVOID])
        bind(self.kernel, "AssignProcessToJobObject", [w.HANDLE, w.HANDLE])
        bind(self.kernel, "ResumeThread", [w.HANDLE], w.DWORD)
        bind(self.kernel, "WaitForSingleObject", [w.HANDLE, w.DWORD], w.DWORD)
        bind(self.kernel, "TerminateProcess", [w.HANDLE, w.UINT])
        bind(self.kernel, "TerminateJobObject", [w.HANDLE, w.UINT])
        bind(self.kernel, "GetExitCodeProcess", [w.HANDLE, ctypes.POINTER(w.DWORD)])
        bind(self.kernel, "CloseHandle", [w.HANDLE])

    def input_desktop(self):
        """Read the selected input desktop name and close its temporary query handle."""
        handle = checked(self.user.OpenInputDesktop(0, False, 1))
        try:
            name, needed = ctypes.create_unicode_buffer(256), w.DWORD()
            checked(self.user.GetUserObjectInformationW(handle, 2, name, ctypes.sizeof(name), ctypes.byref(needed)))
            return name.value
        finally:
            checked(self.user.CloseDesktop(handle))

    def create_desktop(self, name):
        return checked(self.user.CreateDesktopW(name, None, None, 0, 0x01ff, None))

    def create_job(self):
        """Create a job that terminates all owned descendants when its handle closes."""
        job = checked(self.kernel.CreateJobObjectW(None, None))
        try:
            limits = ExtendedJobLimits()
            limits.basic.flags = 0x2000  # JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            checked(self.kernel.SetInformationJobObject(job, 9, ctypes.byref(limits), ctypes.sizeof(limits)))
            return job
        except BaseException:
            self.close_handle(job)
            raise

    def create_process(self, command, desktop):
        """Inherit Puppeteer's debugging pipes and create suspended Chrome on its desktop."""
        import msvcrt

        # Node/libuv passes the five pipe descriptors in STARTUPINFO's CRT table.
        # Copy that table into fresh startup flags for Chrome's private desktop.
        inherited, startup = StartupInfo(), StartupInfo()
        self.kernel.GetStartupInfoW(ctypes.byref(inherited))
        if inherited.cbReserved2 < 4 + 5 * (1 + ctypes.sizeof(w.HANDLE)):
            raise RuntimeError("Puppeteer debugging pipe descriptor table is missing")
        for descriptor in (3, 4):
            if msvcrt.get_osfhandle(descriptor) in (-1, -2):
                raise RuntimeError("Puppeteer debugging pipe handle is unavailable")
        startup.cb = ctypes.sizeof(startup)
        startup.lpDesktop = "winsta0\\" + desktop
        startup.dwFlags = 0x100  # STARTF_USESTDHANDLES
        startup.cbReserved2, startup.lpReserved2 = inherited.cbReserved2, inherited.lpReserved2
        startup.hStdInput = inherited.hStdInput
        startup.hStdOutput, startup.hStdError = inherited.hStdOutput, inherited.hStdError
        process = ProcessInfo()
        arguments = ctypes.create_unicode_buffer(subprocess.list2cmdline(command))
        # Suspension keeps Chrome's first thread stopped until the launcher
        # assigns the child to its descendant-owning, kill-on-close job.
        checked(self.kernel.CreateProcessW(command[0], arguments, None, None, True,
                0x08000004, None, None, ctypes.byref(startup), ctypes.byref(process)))
        return process

    def assign_job(self, job, process):
        checked(self.kernel.AssignProcessToJobObject(job, process.hProcess))

    def resume(self, process):
        if self.kernel.ResumeThread(process.hThread) == 0xffffffff:
            raise ctypes.WinError(ctypes.get_last_error())

    def wait(self, process, milliseconds):
        result = self.kernel.WaitForSingleObject(process.hProcess, milliseconds)
        if result not in (0, 258):
            raise ctypes.WinError(ctypes.get_last_error())
        return result == 0

    def exit_code(self, process):
        code = w.DWORD()
        checked(self.kernel.GetExitCodeProcess(process.hProcess, ctypes.byref(code)))
        return code.value

    def terminate_process(self, process):
        checked(self.kernel.TerminateProcess(process.hProcess, 1))

    def terminate_job(self, job):
        checked(self.kernel.TerminateJobObject(job, 1))

    def job_empty(self, job):
        information = JobAccounting()
        checked(self.kernel.QueryInformationJobObject(job, 1, ctypes.byref(information), ctypes.sizeof(information), None))
        return information.active_processes == 0

    def close_handle(self, handle):
        checked(self.kernel.CloseHandle(handle))

    def close_desktop(self, desktop):
        checked(self.user.CloseDesktop(desktop))
