import requests
import json

url = 'https://app-taxes-production-ec67.up.railway.app/api/assistant/chat'

payload = {
    'message': 'ranking auxilios del interno 118',
    'history': [
        {
            'role': 'user',
            'text': 'ultimo auxilio interno 118'
        },
        {
            'role': 'model',
            'text': '¡Hola! Según el historial, el **último auxilio registrado para el interno 118** fue:\n\n📅 **Fecha:** 25/06/2026\n🔧 **Orden de Trabajo:** 25162\n📋 **Detalle:** Poco embrague y pierde grasa\n🔍 **Diagnóstico:** Caja floja, junta tapa toma rota'
        }
    ]
}

print("Calling chat endpoint for ranking...")
r = requests.post(url, json=payload)
print("Status:", r.status_code)
print("Response JSON:")
try:
    print(json.dumps(r.json(), indent=2))
except Exception as e:
    print("Error parsing JSON:", e)
    print("Raw text:", r.text)
