import sys, pathlib, unittest
sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
import captions

def W(text, t0=0.0, dt=0.3):
    out, t = [], t0
    for w in text.split():
        out.append({"start": t, "end": t + dt, "text": w}); t += dt + 0.05
    return out

class Cues(unittest.TestCase):
    def test_lines_never_exceed_42_chars_and_cues_two_lines(self):
        cs = captions.cues(W("AI agents trade real DreamDEX Event Contracts on Somnia. You can't verify a bot's track record from a screenshot, and nobody could put a price on one."), 0.0, 0.0)
        for c in cs:
            lines = c["text"].split("\\N")
            self.assertLessEqual(len(lines), 2)
            for l in lines: self.assertLessEqual(len(l), 42, l)

    def test_cues_break_at_sentence_end_and_are_offset(self):
        cs = captions.cues(W("Short one. Then another short one."), 10.0, 0.5)
        self.assertEqual(cs[0]["text"], "Short one.")
        self.assertAlmostEqual(cs[0]["start"], 10.5, places=2)

    def test_min_duration_is_enforced_without_overlap(self):
        cs = captions.cues(W("A b. C d e f g h i j k l m n o p q r s t u v w x y z aa bb cc dd."), 0.0, 0.0)
        for a, b in zip(cs, cs[1:]):
            self.assertLessEqual(a["end"], b["start"] + 1e-6)
        self.assertGreaterEqual(cs[-1]["end"] - cs[-1]["start"], 1.2)

class Punctuation(unittest.TestCase):
    def test_words_take_their_spelling_from_the_text(self):
        words = W("Meta Agent DEX's answer is nav on the vault never a token balance")
        out = captions.attach_punctuation(words, "Meta-Agent DEX's answer is nav() on the vault, never a token balance.")
        self.assertEqual([w["text"] for w in out], ["Meta-Agent", "DEX's", "answer", "is", "nav()", "on", "the", "vault,", "never", "a", "token", "balance."])
        self.assertAlmostEqual(out[0]["end"], words[1]["end"])  # "Agent" merged into "Meta-Agent"

if __name__ == "__main__":
    unittest.main()
