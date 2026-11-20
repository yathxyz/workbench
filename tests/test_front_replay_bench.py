"""Acceptance fence for the loaded-echo benchmark; uses the same monotonic clock in both clients."""

from pathlib import Path
import runpy
import unittest


class OverlapTest(unittest.TestCase):
    def test_each_whole_echo_is_inside_one_replay(self):
        check = runpy.run_path(str(Path(__file__).with_name('front-replay-bench.py')))['check_overlap']
        check(100, 200, [(102, 150), (155, 195)])
        for miss in [(99, 110), (190, 201), (201, 205)]:
            with self.subTest(miss=miss), self.assertRaises(RuntimeError):
                # Never silently filter a long RTT just because it straddled the marker.
                check(100, 200, [(102, 150), miss])


if __name__ == '__main__':
    unittest.main()
