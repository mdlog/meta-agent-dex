import sys, pathlib, unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import tts

class Rules(unittest.TestCase):
    def test_segment_is_audio_plus_gap_or_visual_minimum(self):
        self.assertAlmostEqual(tts.segment_seconds(24.9, 500, 12000), 25.8)
        self.assertAlmostEqual(tts.segment_seconds(6.0, 0, 12000), 12.0)

    def test_length_rule(self):
        self.assertEqual(tts.apply_rule(170.0, "+0%"), ("ok", "+0%"))
        self.assertEqual(tts.apply_rule(175.0, "+0%"), ("rerender", "+6%"))
        self.assertEqual(tts.apply_rule(175.0, "+6%"), ("cut", "+6%"))

if __name__ == "__main__":
    unittest.main()
