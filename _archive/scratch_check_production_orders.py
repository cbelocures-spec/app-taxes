import requests
import json

url = 'https://app-taxes-production-ec67.up.railway.app/api/orders'
headers = {
    'x-user-username': 'paniol@contenedoreshugo.com.ar'
}

print("Fetching orders from production...")
r = requests.get(url, headers=headers)
print("Status Code:", r.status_code)
try:
    data = r.json()
    print("Total orders returned:", len(data))
    if data:
        print("Sample order structure:")
        print(json.dumps(data[0], indent=2))
except Exception as e:
    print("Error:", e)
    print("Text:", r.text)
