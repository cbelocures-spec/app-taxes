import requests

print("Fetching CSV from Unidades 2026 sheet...")
url = 'https://docs.google.com/spreadsheets/d/1QK698StrEr9v7HgJUrtN1GFtb3ixk_2ql78dkx1_3Vk/gviz/tq?tqx=out:csv&sheet=Historial%20Services'
csv_data = requests.get(url).text
lines = csv_data.strip().split('\n')

print("Total lines in CSV:", len(lines))
# Match column index 1 (Interno)
i128_rows = []
for idx, line in enumerate(lines):
    parts = line.split(',')
    if len(parts) > 1:
        interno = parts[1].replace('"', '').strip()
        if interno == '128':
            i128_rows.append((idx, line))

print("Total Interno 128 rows:", len(i128_rows))
print("Sample Interno 128 rows:")
for r in i128_rows[:10]:
    print(r)
