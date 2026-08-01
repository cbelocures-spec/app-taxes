import requests

print("Simulating backend filter for Interno 118...")
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

print("Total parsed records from sheet:", len(parsed))

# Simulate server filter:
message = "ranking auxilios del interno 118"
lowerMessage = message.lower()

# Interno match:
targetInterno = "118"

# Keywords:
# We extract keywords from message:
import re
words = re.findall(r'\b\w+\b', lowerMessage)
keywords = [w for w in words if len(w) > 2 and w not in ['del', 'los', 'con', 'para', 'una', 'las', 'por']]
print("Keywords:", keywords)

# Filter history:
filteredHistory = parsed
if targetInterno:
    filteredHistory = [h for h in filteredHistory if h['interno'] == targetInterno]

# Exclude fuel:
filteredHistory = [h for h in filteredHistory if 'COMBUSTIBLE' not in h['tipo'].upper() and 'LTS' not in h['datos'].upper()]

print("Filtered history size:", len(filteredHistory))

# Keyword matching:
matchedRows = []
unmatchedRows = []
for h in filteredHistory:
    textToSearch = f"{h['tipo']} {h['datos']} {h['conductor']} {h['patente']}".lower()
    if any(kw in textToSearch for kw in keywords):
        matchedRows.append(h)
    else:
        unmatchedRows.append(h)

print("Matched rows:", len(matchedRows))
print("Unmatched rows:", len(unmatchedRows))

# Combine:
optimizedHistory = matchedRows + unmatchedRows[:100]
print("Optimized history size before deduplication:", len(optimizedHistory))

# Deduplicate:
seen = set()
deduped = []
for h in optimizedHistory:
    key = f"{h['interno']}-{h['tipo']}-{h['datos']}-{h['day']}-{h['patente']}"
    if key not in seen:
        seen.add(key)
        deduped.append(h)
optimizedHistory = deduped
print("Optimized history size after deduplication:", len(optimizedHistory))

# Sort by rowIndex desc:
optimizedHistory.sort(key=lambda x: x['rowIndex'], reverse=True)

# Limit to 300:
optimizedHistory = optimizedHistory[:300]

# Format:
for h in optimizedHistory[:20]:
    recordDate = '-'
    # Date helper check:
    isDate = lambda s: s and ('/' in s or '-' in s) and len(s) <= 10
    if isDate(h['fecha']):
        recordDate = h['fecha']
    elif isDate(h['patente']):
        recordDate = h['patente']
        
    detailText = h['datos']
    if h['day'] and h['day'] != '-' and h['day'] != h['datos']:
        detailText = f"{h['datos']} ({h['day']})"
        
    print(f"Fecha: {recordDate}, Interno: {h['interno']}, Tipo/Movimiento: {h['tipo']}, Detalle/Trabajo: {detailText}")
