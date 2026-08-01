import requests
from bs4 import BeautifulSoup

r = requests.get('https://app-taxes-production-ec67.up.railway.app/last_catalog_error.html')
soup = BeautifulSoup(r.text, 'html.parser')

print("Title:", soup.title.string if soup.title else "No title")
print("Selects found:", len(soup.find_all('select')))
for i, s in enumerate(soup.find_all('select')):
    print(f"  Select #{i}: name='{s.get('name')}', id='{s.get('id')}', options_count={len(s.find_all('option'))}")

print("\nButtons found:")
for b in soup.find_all(['button', 'a', 'input']):
    text = b.get_text(strip=True)
    if text or b.get('value'):
        print(f"  <{b.name}>: text='{text}', value='{b.get('value')}', name='{b.get('name')}', id='{b.get('id')}'")
