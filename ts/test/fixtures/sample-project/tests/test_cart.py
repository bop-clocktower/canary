from myapp import cart


def test_should_add_item():
    c = cart.add(cart.empty(), "sku-1")
    assert c.count == 1


def test_should_total_reflect_quantity():
    c = cart.add(cart.empty(), "sku-1", 4)
    assert c.total > 0
