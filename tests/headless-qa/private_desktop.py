"""Own the private Windows desktop and Chrome process tree for Puppeteer.

stdin is a stop/parent-lifetime channel; descriptors 3/4 remain Chrome's CDP pipe.
An atomic receipt confirms process-tree exit before the Node harness may remove
its profile. Abrupt launcher termination closes the job and kills its children.
"""
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import threading
import time

from private_desktop_win32 import WindowsDesktop


def configuration(arguments):
    if len(arguments) < 4:
        raise ValueError("Private desktop name, status path and Chrome command are required")
    name, status, *command = arguments
    status = Path(status).resolve()
    if not re.fullmatch(r"EasyEcadQa-[a-f0-9]{32}", name):
        raise ValueError("Invalid private desktop name")
    if (status.name != "private-desktop.json" or status.parent.parent != Path(tempfile.gettempdir()).resolve()
            or not status.parent.name.startswith("easy-ecad-qa-")):
        raise ValueError("Private desktop receipt must be in the QA temporary profile")
    profiles = [argument.split("=", 1)[1] for argument in command[1:] if argument.startswith("--user-data-dir=")]
    if not Path(command[0]).is_absolute() or not Path(command[0]).is_file():
        raise ValueError("Chrome executable must be an existing absolute file")
    if len(profiles) != 1 or Path(profiles[0]).resolve() != status.parent:
        raise ValueError("Chrome must use exactly the QA temporary profile")
    if "--remote-debugging-pipe" not in command:
        raise ValueError("Chrome private debugging pipe argument is missing")
    if any(argument.startswith(("--headless", "--remote-debugging-port")) for argument in command[1:]):
        raise ValueError("Headless Chrome and debugging ports are forbidden")
    return name, status, command


def write_status(filename, value):
    temporary = filename.with_suffix(".tmp")
    temporary.write_text(json.dumps(value), encoding="utf-8")
    os.replace(temporary, filename)


def watch_control(stream, stop):
    for line in stream:
        if line.strip() == "stop":
            break
    stop.set()  # A closed parent pipe also shuts down this owned browser tree.


def cleanup(native, process, job, desktop, assigned=False):
    errors = []

    def attempt(action):
        try:
            return action()
        except Exception as error:
            errors.append(str(error))
            return False

    if job:
        attempt(lambda: native.terminate_job(job))
    # A job termination is asynchronous. Wait for an assigned process instead
    # of racing a second TerminateProcess call against its pending exit.
    if process and not assigned and not attempt(lambda: native.wait(process, 0)):
        attempt(lambda: native.terminate_process(process))
    process_stopped = not process or attempt(lambda: native.wait(process, 5000))
    job_stopped = not job
    if job:
        deadline = time.monotonic() + 5
        while True:
            job_stopped = attempt(lambda: native.job_empty(job))
            if job_stopped or errors or time.monotonic() >= deadline:
                break
            time.sleep(0.05)
    code = attempt(lambda: native.exit_code(process)) if process_stopped and process else None
    if process:
        attempt(lambda: native.close_handle(process.hThread))
        attempt(lambda: native.close_handle(process.hProcess))
    if job:
        attempt(lambda: native.close_handle(job))
    desktop_closed = not desktop
    if desktop:
        try:
            native.close_desktop(desktop)
            desktop_closed = True
        except Exception as error:
            errors.append(str(error))
    return {"processExitConfirmed": bool(process_stopped and job_stopped),
            "desktopClosed": desktop_closed, "chromeExitCode": code, "cleanupErrors": errors}


def run(name, status, command, native, control=sys.stdin):
    process = job = desktop = None
    assigned = False
    state = {"name": name, "phase": "starting", "launcherPid": os.getpid(),
             "chromePid": None, "processExitConfirmed": False, "desktopClosed": False}
    failure = None
    step = "receipt creation"
    try:
        write_status(status, state)
        step = "desktop creation"
        desktop = native.create_desktop(name)
        step = "input desktop verification"
        state["inputDesktop"] = native.input_desktop()
        if state["inputDesktop"] == name:
            raise RuntimeError("QA desktop must differ from the input desktop")
        step = "process job creation"
        job = native.create_job()
        step = "suspended Chrome creation"
        process = native.create_process(command, name)
        state["chromePid"] = process.dwProcessId
        step = "process job assignment"
        native.assign_job(job, process)
        assigned = True
        state["phase"] = "running"
        step = "launch receipt publication"
        write_status(status, state)
        step = "Chrome thread resume"
        native.resume(process)
        stop = threading.Event()
        threading.Thread(target=watch_control, args=(control, stop), daemon=True).start()
        step = "Chrome process observation"
        while not native.wait(process, 100):
            if stop.is_set():
                native.terminate_job(job)
                break
    except Exception as error:
        failure = f"{step}: {error}"
    finally:
        state.update(cleanup(native, process, job, desktop, assigned))
        state["phase"] = "failed" if failure else "exited"
        if failure:
            state["error"] = failure
        write_status(status, state)
    if failure or state["cleanupErrors"] or not state["processExitConfirmed"] or not state["desktopClosed"]:
        raise RuntimeError(failure or "Private desktop cleanup could not be confirmed")


def main():
    if sys.platform != "win32":
        raise RuntimeError("The private-desktop QA browser requires Windows")
    name, status, command = configuration(sys.argv[1:])
    run(name, status, command, WindowsDesktop())


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Private desktop launcher failed: {error}", file=sys.stderr)
        sys.exit(1)
