import requests
import re

url = 'https://docs.google.com/spreadsheets/d/1QK698StrEr9v7HgJUrtN1GFtb3ixk_2ql78dkx1_3Vk/edit'
r = requests.get(url)
html = r.text

bootstrap_match = re.search(r'bootstrapData\s*=\s*(\{.*?\});', html)
if bootstrap_match:
    with open('scratch_bootstrap.json', 'w', encoding='utf-8') as f:
        f.write(bootstrap_match.group(1))
    print("Wrote scratch_bootstrap.json")
else:
    print("No bootstrapData found.")
