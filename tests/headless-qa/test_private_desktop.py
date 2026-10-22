"""Check native-launch orchestration through local process and desktop stubs."""
import io
import json
from pathlib import Path
from types import SimpleNamespace
import tempfile
import threading
import time
import unittest
from unittest.mock import patch

from private_desktop import cleanup, configuration, run, watch_control


class FakeNative:
    """Model job termination as a pending exit completed by the next bounded wait.

    This reproduces native shutdown ordering and tests failed assignment and
    lingering descendants independently of Windows desktop availability.
    """
    def __init__(self, stalled=False, assign_error=False, busy_job=False):
        self.calls = []
        self.exited = False
        self.pending_exit = False
        self.stalled, self.assign_error, self.busy_job = stalled, assign_error, busy_job

    def create_desktop(self, name):
        self.calls.append("desktop")
        return "desktop"

    def input_desktop(self):
        return "Default"

    def create_job(self):
        self.calls.append("job")
        return "job"

    def create_process(self, command, name):
        self.calls.append("suspended-process")
        return SimpleNamespace(hProcess="process", hThread="thread", dwProcessId=456)

    def assign_job(self, job, process):
        self.calls.append("assign")
        if self.assign_error:
            raise OSError("Job assignment refused")

    def resume(self, process):
        self.calls.append("resume")

    def wait(self, process, milliseconds):
        if (self.pending_exit and milliseconds > 0) or (milliseconds == 100 and not self.stalled):
            self.exited = True
        time.sleep(0.001)
        return self.exited

    def terminate_process(self, process):
        self.calls.append("terminate-process")
        if self.pending_exit:
            raise OSError("Termination is already pending")
        self.exited = True

    def terminate_job(self, job):
        self.calls.append("terminate-job")
        if not self.assign_error and not self.exited:
            self.pending_exit = True

    def job_empty(self, job):
        return not self.busy_job

    def exit_code(self, process):
        return 0

    def close_handle(self, handle):
        self.calls.append("close-" + handle)

    def close_desktop(self, desktop):
        self.calls.append("close-desktop")


class PrivateDesktopTests(unittest.TestCase):
    def setUp(self):
        self.profile = tempfile.TemporaryDirectory(prefix="easy-ecad-qa-test-")
        self.addCleanup(self.profile.cleanup)
        self.status = Path(self.profile.name) / "private-desktop.json"
        self.name = "EasyEcadQa-" + "a" * 32
        chrome = Path(self.profile.name) / "chrome.exe"
        chrome.write_bytes(b"test executable")
        self.command = [str(chrome), "--remote-debugging-pipe", "--user-data-dir=" + self.profile.name]

    def test_configuration_rejects_headless_ports_and_other_profiles(self):
        args = [self.name, str(self.status), *self.command]
        self.assertEqual(configuration(args), (self.name, self.status, self.command))
        for extra in ("--headless=new", "--remote-debugging-port=0", "--user-data-dir=other"):
            with self.subTest(extra=extra), self.assertRaises(ValueError):
                configuration([*args, extra])
        with self.assertRaises(ValueError):
            configuration(["Default", *args[1:]])
        with self.assertRaises(ValueError):
            configuration([self.name, str(self.status.parent / "other.json"), *self.command])

    def test_assigns_suspended_chrome_before_it_can_create_descendants(self):
        native = FakeNative()
        resume = native.resume

        def resume_after_receipt(process):
            self.assertEqual(json.loads(self.status.read_text(encoding="utf-8"))["phase"], "running")
            resume(process)

        native.resume = resume_after_receipt
        run(self.name, self.status, self.command, native, io.StringIO(""))
        self.assertEqual(native.calls[:5], ["desktop", "job", "suspended-process", "assign", "resume"])
        self.assertEqual(native.calls[-3:], ["close-process", "close-job", "close-desktop"])
        status = json.loads(self.status.read_text(encoding="utf-8"))
        self.assertEqual(status["phase"], "exited")
        self.assertTrue(status["processExitConfirmed"])
        self.assertTrue(status["desktopClosed"])

    def test_failed_job_assignment_kills_the_still_suspended_child(self):
        native = FakeNative(assign_error=True)
        with self.assertRaisesRegex(RuntimeError, "Job assignment refused"):
            run(self.name, self.status, self.command, native, io.StringIO(""))
        self.assertNotIn("resume", native.calls)
        self.assertIn("terminate-process", native.calls)
        status = json.loads(self.status.read_text(encoding="utf-8"))
        self.assertTrue(status["processExitConfirmed"])
        self.assertTrue(status["desktopClosed"])
        self.assertEqual(status["phase"], "failed")

    def test_parent_eof_and_explicit_stop_both_terminate_the_job(self):
        for value in ("", "stop\n"):
            with self.subTest(value=value):
                native = FakeNative(stalled=True)
                run(self.name, self.status, self.command, native, io.StringIO(value))
                self.assertIn("terminate-job", native.calls)
                self.assertNotIn("terminate-process", native.calls)
                self.assertTrue(json.loads(self.status.read_text(encoding="utf-8"))["processExitConfirmed"])

    def test_receipt_cannot_confirm_cleanup_while_descendants_remain(self):
        native = FakeNative(busy_job=True)
        with patch("private_desktop.time.monotonic", side_effect=[0, 10]), self.assertRaises(RuntimeError):
            run(self.name, self.status, self.command, native, io.StringIO(""))
        status = json.loads(self.status.read_text(encoding="utf-8"))
        self.assertFalse(status["processExitConfirmed"])
        self.assertIn("close-desktop", native.calls)

    def test_cleanup_retains_errors_even_when_later_handles_can_close(self):
        native = FakeNative()
        native.close_desktop = lambda _: (_ for _ in ()).throw(OSError("Desktop close failed"))
        result = cleanup(native, None, "job", "desktop")
        self.assertFalse(result["desktopClosed"])
        self.assertEqual(result["cleanupErrors"], ["Desktop close failed"])
        self.assertIn("close-job", native.calls)

    def test_control_reader_ignores_other_lines_until_stop_or_eof(self):
        stop = threading.Event()
        watch_control(io.StringIO("ignored\nstop\n"), stop)
        self.assertTrue(stop.is_set())


if __name__ == "__main__":
    unittest.main()
