"""
Account management: multiple named logins instead of one shared password. One or more
accounts are admins, who can manage the rest from the User Settings tab (app.py gates
that tab's RPC functions to admins only - this module itself doesn't check permissions).
"""

from werkzeug.security import generate_password_hash, check_password_hash

from sheets import SessionLocal, User

MIN_PASSWORD_LENGTH = 6


def _serialize(u):
    return {"id": u.id, "username": u.username, "email": u.email or "",
            "salesRepName": u.display_name or "", "isAdmin": bool(u.is_admin)}


def listUsers():
    with SessionLocal() as s:
        rows = s.query(User).order_by(User.username).all()
        return [_serialize(u) for u in rows]


def addUser(username, email, password, isAdmin=False, salesRepName=None):
    username = (username or "").strip()
    if not username:
        raise Exception("Username is required.")
    if not password or len(password) < MIN_PASSWORD_LENGTH:
        raise Exception("Password must be at least %d characters." % MIN_PASSWORD_LENGTH)
    with SessionLocal() as s:
        if s.query(User).filter(User.username == username).first():
            raise Exception('A user named "%s" already exists.' % username)
        s.add(User(username=username, email=(email or "").strip() or None,
                    password_hash=generate_password_hash(password), is_admin=bool(isAdmin),
                    display_name=(salesRepName or "").strip() or None))
        s.commit()
    return listUsers()


def updateUserSalesRepName(userId, salesRepName):
    with SessionLocal() as s:
        u = s.get(User, int(userId))
        if not u:
            raise Exception("User not found.")
        u.display_name = (salesRepName or "").strip() or None
        s.commit()
    return listUsers()


def deleteUser(userId):
    with SessionLocal() as s:
        u = s.get(User, int(userId))
        if not u:
            raise Exception("User not found.")
        if u.is_admin and s.query(User).filter(User.is_admin.is_(True)).count() <= 1:
            raise Exception("Can't delete the last admin account.")
        s.delete(u)
        s.commit()
    return listUsers()


def updateUserPassword(userId, newPassword):
    if not newPassword or len(newPassword) < MIN_PASSWORD_LENGTH:
        raise Exception("Password must be at least %d characters." % MIN_PASSWORD_LENGTH)
    with SessionLocal() as s:
        u = s.get(User, int(userId))
        if not u:
            raise Exception("User not found.")
        u.password_hash = generate_password_hash(newPassword)
        s.commit()
    return listUsers()


def verify_login(username, password):
    """Return the matching User row if the credentials check out, else None."""
    username = (username or "").strip()
    with SessionLocal() as s:
        u = s.query(User).filter(User.username == username).first()
        if u and check_password_hash(u.password_hash, password or ""):
            return _serialize(u)
    return None
