import requests

url = 'https://docs.google.com/spreadsheets/d/1QK698StrEr9v7HgJUrtN1GFtb3ixk_2ql78dkx1_3Vk/export?format=csv&gid=659919704'
print("Fetching direct CSV export...")
r = requests.get(url)
print("Status Code:", r.status_code)
lines = r.text.strip().split('\n')
print("Total lines exported:", len(lines))
print("Sample header:", lines[0])
print("Sample first row:", lines[1] if len(lines) > 1 else "None")
