#!/usr/bin/env python3
import base64
import json
import os
import time
from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
from cryptography.hazmat.primitives import padding
# Clé 128-bit (16 octets ou hexadécimal 32 caractères)
SECRET_KEY_RAW = os.environ.get("JSON_KEY", "VOTRE_CLE_16_OCTETS")
if len(SECRET_KEY_RAW) == 32:
    key = bytes.fromhex(SECRET_KEY_RAW)
else:
    key = SECRET_KEY_RAW.encode('utf-8')[:16]
# Définition de la session RDP vers le pod XRDP
payload = {
    "username": "rdpuser",
    "expires": int((time.time() + 3600) * 1000),  # Valide 1 heure
    "connections": {
        "Session-XRDP-Test": {
            "protocol": "rdp",
            "parameters": {
                "hostname": "xrdp-test-service.rdp-sessions.svc.cluster.local",
                "port": "3389",
                "username": "rdpuser",
                "password": "rdppassword",
                "ignore-cert": "true",
                "security": "any"
            }
        }
    }
}
# Chiffrement AES-128-CBC avec PKCS7
data_bytes = json.dumps(payload).encode('utf-8')
padder = padding.PKCS7(128).padder()
padded_data = padder.update(data_bytes) + padder.finalize()
iv = os.urandom(16)
cipher = Cipher(algorithms.AES(key), modes.CBC(iv))
encryptor = cipher.encryptor()
ciphertext = encryptor.update(padded_data) + encryptor.finalize()
# Concaténation IV + Ciphertext, encodée en base64
auth_token = base64.b64encode(iv + ciphertext).decode('utf-8')
print("\n--- TOKEN GUACAMOLE AUTH-JSON ---")
print(auth_token)
print("\n--- LIEN DIRECT NAVIGATEUR ---")
print(f"http://localhost:8080/guacamole/#/?data={auth_token}")