import requests

url_active = 'https://app-taxes-production-ec67.up.railway.app/api/orders'
url_archived = 'https://app-taxes-production-ec67.up.railway.app/api/orders/archived'

headers = {
    'x-user-username': 'paniol@contenedoreshugo.com.ar'
}

print("Querying active orders...")
r1 = requests.get(url_active, headers=headers)
print("Active orders status:", r1.status_code)
print("Active orders text:", r1.text[:300])

print("\nQuerying archived orders...")
r2 = requests.get(url_archived, headers=headers)
print("Archived orders status:", r2.status_code)
print("Archived orders text:", r2.text[:300])
