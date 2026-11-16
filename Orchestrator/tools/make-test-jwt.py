#!/usr/bin/env python3
"""Génère un JWT HS256 de test accepté par l'orchestrateur.

La clé est lue dans AUTH_JWT_SECRET, sinon dans le secret Kubernetes
guacamole-system/orchestrator-auth (kubectl doit pointer sur le cluster).

Usage :
  python3 Orchestrator/tools/make-test-jwt.py [sub] [durée_en_secondes]
  python3 Orchestrator/tools/make-test-jwt.py alice 300
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import subprocess
import sys
import time


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def load_secret() -> str:
    env = os.environ.get("AUTH_JWT_SECRET")
    if env:
        return env
    raw = subprocess.check_output([
        "kubectl", "-n", "guacamole-system", "get", "secret", "orchestrator-auth",
        "-o", "jsonpath={.data.AUTH_JWT_SECRET}",
    ])
    return base64.b64decode(raw).decode()


def main() -> None:
    sub = sys.argv[1] if len(sys.argv) > 1 else "utilisateur-test"
    ttl = int(sys.argv[2]) if len(sys.argv) > 2 else 300
    now = int(time.time())
    header = {"alg": "HS256", "typ": "JWT"}
    claims = {
        "sub": sub,
        "aud": "rdp-orchestrator",
        "iat": now,
        "exp": now + ttl,
        "jti": secrets.token_hex(8),
    }
    signing_input = f"{b64url(json.dumps(header, separators=(',', ':')).encode())}." \
                    f"{b64url(json.dumps(claims, separators=(',', ':')).encode())}"
    sig = hmac.new(load_secret().encode(), signing_input.encode(), hashlib.sha256).digest()
    print(f"{signing_input}.{b64url(sig)}")


if __name__ == "__main__":
    main()
