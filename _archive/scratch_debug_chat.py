import requests

url = 'https://app-taxes-production-ec67.up.railway.app/api/assistant/chat'

with open('scratch_debug_chat_output.txt', 'w', encoding='utf-8') as f:
    f.write("Test 1: Sending message with NO history...\n")
    try:
        r1 = requests.post(url, json={'message': 'hola'})
        f.write(f"Status: {r1.status_code}\n")
        f.write(f"Response: {r1.text}\n")
    except Exception as e:
        f.write(f"Error: {e}\n")

    f.write("\nTest 2: Sending message WITH history...\n")
    try:
        r2 = requests.post(url, json={
            'message': 'ultimo correctivo realizado',
            'history': [
                {'role': 'user', 'text': 'hola'},
                {'role': 'model', 'text': '¡Hola! Soy Hugo AI, tu asistente de taller.'}
            ]
        })
        f.write(f"Status: {r2.status_code}\n")
        f.write(f"Response: {r2.text}\n")
    except Exception as e:
        f.write(f"Error: {e}\n")

print("Wrote scratch_debug_chat_output.txt")
