from src.pricing import total


def test_total_adds_shipping():
    assert total(10, 3) == 13
