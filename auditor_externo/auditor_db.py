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
                "ordenes_resincronizadas": [],
                "tareas_confirmadas": [],
                "tareas_resincronizadas": []
            }
            self._write(initial_data)

    def _read(self):
        try:
            with open(self.db_path, "r", encoding="utf-8") as f:
                return json.load(f)
        except Exception as e:
            print(f"[DB-Error] Error reading db: {e}")
            return {
                "ordenes_borradas": [],
                "ordenes_resincronizadas": [],
                "tareas_confirmadas": [],
                "tareas_resincronizadas": []
            }

    def _write(self, data):
        try:
            with open(self.db_path, "w", encoding="utf-8") as f:
                json.dump(data, f, ensure_ascii=False, indent=2)
        except Exception as e:
            print(f"[DB-Error] Error writing db: {e}")

    def clear_all_history(self):
        empty_data = {
            "ordenes_borradas": [],
            "ordenes_resincronizadas": [],
            "tareas_confirmadas": [],
            "tareas_resincronizadas": []
        }
        self._write(empty_data)
        return True

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

    def get_tareas_confirmadas(self):
        data = self._read()
        return data.get("tareas_confirmadas", [])

    def get_tareas_resincronizadas(self):
        data = self._read()
        return data.get("tareas_resincronizadas", [])

    def add_tarea_confirmada(self, entry):
        data = self._read()
        if "tareas_confirmadas" not in data:
            data["tareas_confirmadas"] = []

        now_str = datetime.now().strftime("%d/%m/%Y, %H:%M:%S")
        record = {
            "id": f"TASK-LOCK-{int(datetime.now().timestamp())}",
            "fechaConfirmado": now_str,
            "numeroOrden": str(entry.get("taxesOrderNumber") or entry.get("ot") or entry.get("orderId") or "N/A"),
            "interno": str(entry.get("interno") or "N/A"),
            "sector": str(entry.get("clasificacion") or entry.get("sector") or "Taller"),
            "empleado": str(entry.get("empleado") or "N/A"),
            "horas": str(entry.get("horasEstimadas") or entry.get("horas") or "0"),
            "descripcion": str(entry.get("descripcion") or "N/A"),
            "insumos": str(entry.get("insumos") or "-")
        }
        data["tareas_confirmadas"].insert(0, record)
        self._write(data)
        return record

    def add_tarea_resincronizada(self, entry):
        data = self._read()
        if "tareas_resincronizadas" not in data:
            data["tareas_resincronizadas"] = []

        now_str = datetime.now().strftime("%d/%m/%Y, %H:%M:%S")
        record = {
            "id": f"TASK-RESYNC-{int(datetime.now().timestamp())}",
            "fechaResincronizado": now_str,
            "numeroOrden": str(entry.get("taxesOrderNumber") or entry.get("ot") or entry.get("orderId") or "N/A"),
            "interno": str(entry.get("interno") or "N/A"),
            "sector": str(entry.get("clasificacion") or entry.get("sector") or "Taller"),
            "empleado": str(entry.get("empleado") or "N/A"),
            "horas": str(entry.get("horasEstimadas") or entry.get("horas") or "0"),
            "descripcion": str(entry.get("descripcion") or "N/A"),
            "motivo": str(entry.get("motivo") or entry.get("observacion") or "Discrepancia en Taxes")
        }
        data["tareas_resincronizadas"].insert(0, record)
        self._write(data)
        return record

if __name__ == "__main__":
    db = AuditorDB()
    print("DB initialized successfully. Borradas:", len(db.get_ordenes_borradas()), "Resincronizadas:", len(db.get_ordenes_resincronizadas()))
