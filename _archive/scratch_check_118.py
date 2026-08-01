import requests
import csv
import io

print("Fetching CSV...")
url = 'https://docs.google.com/spreadsheets/d/1QK698StrEr9v7HgJUrtN1GFtb3ixk_2ql78dkx1_3Vk/gviz/tq?tqx=out:csv&sheet=Historial%20Services'
csv_text = requests.get(url).text

# Parse using python csv reader (which handles newlines in cells perfectly!)
f = io.StringIO(csv_text.strip())
reader = csv.reader(f)
rows = list(reader)

print("Total parsed rows:", len(rows))
# Let's see rows with Interno = '118'
i118_rows = []
for idx, r in enumerate(rows):
    if len(r) > 1 and r[1].strip() == '118':
        i118_rows.append((idx, r))

print("Total 118 rows:", len(i118_rows))
print("Sample 118 rows:")
for idx, r in i118_rows[:5]:
    print(idx, r)
