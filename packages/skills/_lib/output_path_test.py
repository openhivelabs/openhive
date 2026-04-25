"""Unit tests for `_lib.output_path.resolve_out`.

Run from packages/skills:
    python -m pytest _lib/output_path_test.py -q
or:
    python _lib/output_path_test.py
"""

from __future__ import annotations

import os
import pathlib
import sys
import tempfile
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from _lib.output_path import resolve_out  # noqa: E402


class ResolveOutTest(unittest.TestCase):
    def setUp(self) -> None:
        self._saved = {
            k: os.environ.get(k)
            for k in ("OPENHIVE_OUTPUT_DIR", "OPENHIVE_SKILL_INTERNAL")
        }
        for k in self._saved:
            os.environ.pop(k, None)

    def tearDown(self) -> None:
        for k, v in self._saved.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v

    def test_passthrough_when_env_unset(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            target = pathlib.Path(tmp) / "foo.pdf"
            got = resolve_out(str(target))
            self.assertEqual(got, target.resolve())

    def test_bare_name_lands_in_artifact_dir(self) -> None:
        with tempfile.TemporaryDirectory() as art:
            os.environ["OPENHIVE_OUTPUT_DIR"] = art
            got = resolve_out("report.pdf")
            self.assertEqual(got, (pathlib.Path(art) / "report.pdf").resolve())

    def test_absolute_path_rewritten_to_artifact_dir(self) -> None:
        with tempfile.TemporaryDirectory() as art:
            os.environ["OPENHIVE_OUTPUT_DIR"] = art
            got = resolve_out("/tmp/foo.pdf")
            self.assertEqual(got, (pathlib.Path(art) / "foo.pdf").resolve())

    def test_relative_with_dir_component_rewritten(self) -> None:
        with tempfile.TemporaryDirectory() as art:
            os.environ["OPENHIVE_OUTPUT_DIR"] = art
            got = resolve_out("subdir/foo.pdf")
            self.assertEqual(got, (pathlib.Path(art) / "foo.pdf").resolve())

    def test_internal_flag_short_circuits(self) -> None:
        with tempfile.TemporaryDirectory() as art:
            os.environ["OPENHIVE_OUTPUT_DIR"] = art
            os.environ["OPENHIVE_SKILL_INTERNAL"] = "1"
            with tempfile.TemporaryDirectory() as tmp:
                target = pathlib.Path(tmp) / "interim.pdf"
                got = resolve_out(str(target))
                self.assertEqual(got, target.resolve())

    def test_path_object_accepted(self) -> None:
        with tempfile.TemporaryDirectory() as art:
            os.environ["OPENHIVE_OUTPUT_DIR"] = art
            got = resolve_out(pathlib.Path("/tmp/x.pdf"))
            self.assertEqual(got, (pathlib.Path(art) / "x.pdf").resolve())

    def test_empty_raises(self) -> None:
        with self.assertRaises(ValueError):
            resolve_out("")


if __name__ == "__main__":
    unittest.main()
