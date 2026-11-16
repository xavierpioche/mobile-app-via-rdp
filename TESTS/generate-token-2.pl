#!/usr/bin/env python3
import base64, hashlib, hmac, json, os, sys, time
from urllib.parse import quote
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding

key_hex = os.environ.get("JSON_KEY")
if not key_hex or len(key_hex) != 32:
    sys.exit("JSON_KEY doit contenir 32 caractères hexadécimaux (= json-secret-key)")
key = bytes.fromhex(key_hex)

payload = {
    "username": "rdpuser",
    "expires": int((time.time() + 3600) * 1000),
    "connections": {
        "Session-XRDP-Test": {
            "protocol": "rdp",
            "parameters": {
                "hostname": "xrdp-test-service.rdp-sessions.svc.cluster.local",
                "port": "3389",
                "username": "rdpuser",
                "password": "rdppassword",
                "ignore-cert": "true",
                "security": "any",
            },
        }
    },
}

data = json.dumps(payload).encode("utf-8")
signature = hmac.new(key, data, hashlib.sha256).digest()   # 32 octets
plaintext = signature + data

padder = padding.PKCS7(128).padder()
padded = padder.update(plaintext) + padder.finalize()

encryptor = Cipher(algorithms.AES(key), modes.CBC(b"\x00" * 16)).encryptor()  # IV nul
token = base64.b64encode(encryptor.update(padded) + encryptor.finalize()).decode()

print("\n--- TOKEN ---\n" + token)
print("\n--- LIEN ---\nhttp://localhost:8080/guacamole/?data=" + quote(token, safe=""))