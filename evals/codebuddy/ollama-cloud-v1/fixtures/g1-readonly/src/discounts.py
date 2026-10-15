def apply_discount(amount, discount):
    """Apply a non-negative discount to an amount."""
    return amount - max(discount, 0)
