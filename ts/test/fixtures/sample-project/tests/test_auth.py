import pytest
from myapp import auth


@pytest.fixture
def client():
    return auth.Client()


def test_should_login_with_valid_credentials(client):
    assert client.login("u", "p").ok


def test_should_reject_invalid_password(client):
    assert not client.login("u", "x").ok
