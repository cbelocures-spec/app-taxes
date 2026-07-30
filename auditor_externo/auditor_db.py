import os
import json
from datetime import datetime

DB_FILE = os.path.join(os.path.dirname(__file__), "db_auditor.json")

class AuditorDB:
    def __init__(self, db_path=DB_FILE):
        self.db_path = db_path
        self._ensure_db()

    def _ensure_db(self):
        if not os.path.exists(self.db_path):
            initial_data = {
                "ordenes_borradas": [],
                "ordenes_resincronizadas": []
            }
            self._write(initial_data)

    def _read(self):
        try:
            with open(self.db_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[DB-Error] Error reading db: {e}")
            return {"ordenes_borradas": [], "ordenes_resincronizadas": []}

    def _write(self, data):
        try:
            with open(self.db_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[DB-Error] Error writing db: {e}")

    def get_ordenes_borradas(self):
        data = self._read()
        return data.get("ordenes_borradas", [])

    def get_ordenes_resincronizadas(self):
        data = self._read()
        return data.get("ordenes_resincronizadas", [])

    def add_orden_borrada(self, entry):
        """
        entry dictionary should contain:
        - numeroOrden (OT)
        - interno
        - empleado
        - horas
        - descripcion
        - clasificacion
        - realizada ("SI")
        - tasks (list)
        """
        data = self._read()
        if "ordenes_borradas" not in data:
            data["ordenes_borradas"] = []
        
        now_str = datetime.now().strftime("%d/%m/%Y, %H:%M:%S")
        record = {
            "id": f"DEL-{int(datetime.now().timestamp())}",
            "fechaBorrado": now_str,
            "numeroOrden": str(entry.get("numeroOrden") or entry.get("taxesOrderNumber") or "N/A"),
            "interno": str(entry.get("interno") or "N/A"),
            "empleado": str(entry.get("empleado") or "N/A"),
            "horas": str(entry.get("horas") or "0"),
            "descripcion": str(entry.get("descripcion") or "N/A"),
            "clasificacion": str(entry.get("clasificacion") or "MECANICA / Correctivo"),
            "realizada": "SI",
            "tasks": entry.get("tasks", [])
        }
        data["ordenes_borradas"].insert(0, record)
        self._write(data)
        return record

    def add_orden_resincronizada(self, entry):
        """
        entry dictionary should contain:
        - numeroOrden (OT)
        - interno
        - empleado
        - horasApp
        - horasTaxes
        - descripcion
        - clasificacion
        - realizada
        - observacion (reason for resync)
        - tasks (list)
        """
        data = self._read()
        if "ordenes_resincronizadas" not in data:
            data["ordenes_resincronizadas"] = []

        now_str = datetime.now().strftime("%d/%m/%Y, %H:%M:%S")
        record = {
            "id": f"RESYNC-{int(datetime.now().timestamp())}",
            "fechaResincronizado": now_str,
            "numeroOrden": str(entry.get("numeroOrden") or entry.get("taxesOrderNumber") or "N/A"),
            "interno": str(entry.get("interno") or "N/A"),
            "empleado": str(entry.get("empleado") or "N/A"),
            "horasApp": str(entry.get("horasApp") or "0"),
            "horasTaxes": str(entry.get("horasTaxes") or "0"),
            "descripcion": str(entry.get("descripcion") or "N/A"),
            "clasificacion": str(entry.get("clasificacion") or "MECANICA / Correctivo"),
            "realizada": str(entry.get("realizada") or "NO"),
            "observacion": str(entry.get("observacion") or "Discrepancia detectada"),
            "tasks": entry.get("tasks", [])
        }
        data["ordenes_resincronizadas"].insert(0, record)
        self._write(data)
        return record

if __name__ == "__main__":
    db = AuditorDB()
    print("DB initialized successfully. Borradas:", len(db.get_ordenes_borradas()), "Resincronizadas:", len(db.get_ordenes_resincronizadas()))
