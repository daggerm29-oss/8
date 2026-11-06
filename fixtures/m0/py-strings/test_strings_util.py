import unittest

from strings_util import slugify, truncate


class SlugifyTest(unittest.TestCase):
    def test_lowercases_and_joins(self):
        self.assertEqual(slugify("Hello World"), "hello-world")

    def test_strips_punctuation(self):
        self.assertEqual(slugify("  Ship it, NOW!  "), "ship-it-now")


class TruncateTest(unittest.TestCase):
    def test_short_text_unchanged(self):
        self.assertEqual(truncate("abc", 5), "abc")

    def test_long_text_cut(self):
        self.assertEqual(truncate("abcdefgh", 5), "abcd…")


if __name__ == "__main__":
    unittest.main()
