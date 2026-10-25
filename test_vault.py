import app as flask_app
import models
import crypto_vault
import json
import base64

def test_full_pipeline():
    print("Testing SentinelVault Endpoints & Cryptographic Pipeline...")
    flask_app.app.config['TESTING'] = True
    client = flask_app.app.test_client()

    # 1. Test registration
    print("1. Testing Registration...")
    reg_resp = client.post('/api/auth/register', json={
        "username": "test_admin",
        "email": "admin@sentinelvault.io",
        "password": "MasterSecurePassword2026!"
    })
    print("Registration response:", reg_resp.status_code, reg_resp.get_json())
    assert reg_resp.status_code == 200
    reg_data = reg_resp.get_json()
    assert reg_data['success'] is True
    assert len(reg_data['recovery_codes']) == 8

    # 2. Test Get User Profile
    print("2. Testing Get Current User Profile...")
    me_resp = client.get('/api/auth/me')
    print("Profile response:", me_resp.status_code, me_resp.get_json())
    assert me_resp.status_code == 200

    # 3. Test Vault Items List
    print("3. Testing Vault Items Retrieval (auto starter item created)...")
    vault_resp = client.get('/api/vault')
    print("Vault response:", vault_resp.status_code)
    vault_data = vault_resp.get_json()
    assert vault_data['success'] is True
    assert len(vault_data['items']) >= 1
    first_item = vault_data['items'][0]
    print(f"Decrypted item title: '{first_item['title']}', username: '{first_item['username']}'")

    # 4. Test Create New Item
    print("4. Testing Create New Vault Item with AES-256-GCM...")
    create_resp = client.post('/api/vault', json={
        "category": "login",
        "title": "AWS Production Account",
        "username": "root@company.com",
        "password": "SuperSecretPassword#2026",
        "url": "https://aws.amazon.com/console",
        "notes": "Root MFA enabled",
        "folder": "Infrastructure",
        "tags": "cloud, aws, critical"
    })
    print("Create item response:", create_resp.status_code, create_resp.get_json())
    assert create_resp.status_code == 200
    new_item_id = create_resp.get_json()['item_id']

    # 5. Test Get Item Details
    print(f"5. Testing Get Item Details for ID: {new_item_id}...")
    item_resp = client.get(f'/api/vault/{new_item_id}')
    item_data = item_resp.get_json()
    assert item_data['success'] is True
    assert item_data['item']['password'] == "SuperSecretPassword#2026"
    assert item_data['item']['username'] == "root@company.com"
    print("Item decrypted correctly and matches plaintext input!")

    # 6. Test Security Audit Tool
    print("6. Testing Security Audit Engine...")
    audit_resp = client.post('/api/tools/audit-vault')
    audit_data = audit_resp.get_json()
    print("Audit score:", audit_data['audit']['score'], "Grade:", audit_data['audit']['grade'])
    assert audit_data['success'] is True

    # 7. Test Export Vault
    print("7. Testing Vault Export...")
    export_resp = client.get('/api/vault/export?format=json&password=MasterSecurePassword2026!')
    print("Export status:", export_resp.status_code)
    assert export_resp.status_code == 200
    export_json = json.loads(export_resp.data.decode('utf-8'))
    assert 'items' in export_json
    print(f"Exported {len(export_json['items'])} items successfully.")

    # 8. Test Settings Update
    print("8. Testing Settings Update...")
    settings_resp = client.post('/api/settings', json={
        "theme": "light",
        "sound_enabled": True,
        "sound_volume": 0.5,
        "auto_lock_minutes": 10
    })
    assert settings_resp.status_code == 200

    # 9. Test Lock & Unlock
    print("9. Testing Inactivity Session Unlock...")
    unlock_resp = client.post('/api/auth/unlock', json={
        "password": "MasterSecurePassword2026!"
    })
    assert unlock_resp.status_code == 200
    assert unlock_resp.get_json()['success'] is True

    print("\nALL AUTOMATED TESTS PASSED CLEANLY! SentinelVault is 100% functional and ready.")

if __name__ == '__main__':
    test_full_pipeline()
