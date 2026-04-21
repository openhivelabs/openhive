"""Unit tests for ``verify.py``.

Run:
    python3 -m unittest packages/skills/_lib/verify_test.py
"""
from __future__ import annotations

import io
import json
import os
import subprocess
import sys
import tempfile
import unittest
from contextlib import redirect_stdout

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)

from verify import EmitError, check_file, emit_error, emit_success  # noqa: E402


class CheckFileTests(unittest.TestCase):
    def test_missing_file_raises_empty_output(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            missing = os.path.join(d, "nope.pdf")
            with self.assertRaises(EmitError) as ctx:
                check_file(missing, min_bytes=10)
            self.assertEqual(ctx.exception.code, "empty_output")
            self.assertTrue(ctx.exception.suggestion)

    def test_too_small_file_raises_tiny_output(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "tiny.pdf")
            with open(p, "wb") as f:
                f.write(b"hi")
            with self.assertRaises(EmitError) as ctx:
                check_file(p, min_bytes=100)
            self.assertEqual(ctx.exception.code, "tiny_output")

    def test_ok_file_passes(self) -> None:
        with tempfile.TemporaryDirectory() as d:
            p = os.path.join(d, "ok.pdf")
            with open(p, "wb") as f:
                f.write(b"x" * 200)
            # should not raise
            check_file(p, min_bytes=100)


class EmitSuccessTests(unittest.TestCase):
    def test_emit_success_writes_valid_json(self) -> None:
        buf = io.StringIO()
        with redirect_stdout(buf):
            emit_success(
                files=[{"name": "a.pdf", "path": "/tmp/a.pdf", "mime": "application/pdf"}],
                warnings=["minor"],
            )
        line = buf.getvalue().strip().splitlines()[-1]
        payload = json.loads(line)
        self.assertTrue(payload["ok"])
        self.assertEqual(len(payload["files"]), 1)
        self.assertEqual(payload["warnings"], ["minor"])


class EmitErrorTests(unittest.TestCase):
    def test_emit_error_exits_nonzero_with_json(self) -> None:
        # Run in a subprocess because emit_error calls sys.exit(1).
        code = (
            "import sys, os; sys.path.insert(0, %r);\n"
            "from verify import emit_error;\n"
            "emit_error('bad_spec', 'boom', 'try again')\n"
        ) % HERE
        proc = subprocess.run(
            [sys.executable, "-c", code],
            capture_output=True,
            text=True,
        )
        self.assertEqual(proc.returncode, 1)
        line = proc.stdout.strip().splitlines()[-1]
        payload = json.loads(line)
        self.assertFalse(payload["ok"])
        self.assertEqual(payload["error_code"], "bad_spec")
        self.assertEqual(payload["message"], "boom")
        self.assertEqual(payload["suggestion"], "try again")


if __name__ == "__main__":
    unittest.main()
