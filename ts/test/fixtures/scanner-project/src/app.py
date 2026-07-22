"""Sample application module for scanner parity fixtures."""


class UserService:
    def __init__(self):
        self.users = []


def create_user(name):
    return {"name": name}


def _private_helper():
    return 1


@app.get("/users")
def list_users():
    return []


@app.post("/users")
def add_user():
    return {}
