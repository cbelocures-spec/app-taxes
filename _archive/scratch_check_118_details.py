import requests

url = 'https://docs.google.com/spreadsheets/d/1QK698StrEr9v7HgJUrtN1GFtb3ixk_2ql78dkx1_3Vk/export?format=csv&gid=659919704'
r = requests.get(url)
lines = r.text.strip().split('\n')

parsed = []
for i in range(1, len(lines)):
    line = lines[i]
    parts = line.split(',')
    if len(parts) >= 6:
        clean = lambda val: (val or '').replace('"', '').strip()
        parsed.append({
            'rowIndex': i + 1,
            'fecha': clean(parts[0]),
            'interno': clean(parts[1]),
            'tipo': clean(parts[2]),
            'datos': clean(parts[3]),
            'conductor': clean(parts[4]),
            'patente': clean(parts[5]),
            'day': clean(parts[7]) if len(parts) > 7 else '',
            'month': clean(parts[8]) if len(parts) > 8 else ''
        })

filtered = [h for h in parsed if h['interno'] == '118' and 'COMBUSTIBLE' not in h['tipo'].upper()]
filtered.sort(key=lambda x: x['rowIndex'], reverse=True)

print("Total filtered rows for 118:", len(filtered))
print("Top 15 rows for Interno 118:")
for h in filtered[:15]:
    print(f"RowIndex: {h['rowIndex']}, Fecha(A): {h['fecha']}, Patente(F): {h['patente']}, Tipo: {h['tipo']}, Trabajo(H): {h['day']}")
