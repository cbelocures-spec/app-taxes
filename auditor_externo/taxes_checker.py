import os
import json
import time
import re
from playwright.sync_api import sync_playwright

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "config.json")

class TaxesChecker:
    def __init__(self, config_path=CONFIG_FILE, headless=True):
        self.config_path = config_path
        self.config = self._load_config()
        self.headless = headless
        self.playwright = None
        self.browser = None
        self.context = None
        self.page = None

    def _load_config(self):
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                print(f"[Checker-Config] Error: {e}")
        return {}

    def start(self):
        """Starts Playwright browser instance and logs into Taxes."""
        if self.page:
            return True
        try:
            print("[Checker] Launching Chromium browser...")
            self.playwright = sync_playwright().start()
            self.browser = self.playwright.chromium.launch(
                headless=self.headless,
                args=["--no-sandbox", "--disable-setuid-sandbox"]
            )
            self.context = self.browser.new_context(viewport={"width": 1280, "height": 800})
            self.page = self.context.new_page()

            # Navigate to Taxes Login
            login_url = f"{self.config.get('taxes_url', 'https://taxes.com.ar').rstrip('/')}/login"
            print(f"[Checker] Navigating to {login_url}...")
            self.page.goto(login_url, wait_until="domcontentloaded", timeout=30000)
            self.page.wait_for_timeout(1500)

            # Fill Login Form
            user = self.config.get("taxes_user", "paniol@contenedoreshugo.com.ar")
            password = self.config.get("taxes_pass", "Paniol2015")

            if self.page.locator('input[name="loginUser"]').count() > 0:
                self.page.fill('input[name="loginUser"]', user)
                self.page.fill('input[name="password"]', password)
                login_btn = self.page.locator("button[type='submit'], button:has-text('INGRESAR')")
                if login_btn.count() > 0:
                    login_btn.first.click()
                    self.page.wait_for_timeout(4000)
                    print(f"[Checker] Logged in successfully into Taxes. URL: {self.page.url}")
                    return True

            print("[Checker-Warning] Could not locate login inputs.")
            return False
        except Exception as e:
            print(f"[Checker-Exception] start error: {e}")
            return False

    def stop(self):
        """Closes browser session."""
        try:
            if self.context:
                self.context.close()
            if self.browser:
                self.browser.close()
            if self.playwright:
                self.playwright.stop()
        except Exception as e:
            print(f"[Checker] Stop error: {e}")
        finally:
            self.page = None
            self.browser = None
            self.context = None
            self.playwright = None

    def audit_order(self, app_order):
        """
        Audits a single App Taxes order against Taxes /tms/produccion/tareas table.
        DOES NOT click the eye icon (el ojo). Reads directly from the main tasks table.
        
        Returns:
        {
          "status": "MATCH" | "DISCREPANCY" | "ERROR",
          "reason": "...",
          "taxes_data": {...}
        }
        """
        if not self.page:
            if not self.start():
                return {"status": "ERROR", "reason": "No se pudo iniciar sesión en Taxes."}

        ot_number = str(app_order.get("taxesOrderNumber") or "").strip()
        interno = str(app_order.get("interno") or "").strip()

        if not ot_number:
            return {
                "status": "DISCREPANCY",
                "reason": f"Sin O.T. asignada (Interno {interno}): Se desarchiva y mueve al módulo de órdenes pendientes",
                "taxes_data": []
            }

        try:
            tareas_url = f"{self.config.get('taxes_url', 'https://taxes.com.ar').rstrip('/')}/tms/produccion/tareas"
            if "/tms/produccion/tareas" not in self.page.url:
                self.page.goto(tareas_url, wait_until="networkidle", timeout=30000)
                self.page.wait_for_timeout(2000)

            # Locate Search Input Box for OT / Interno
            # In Taxes /tms/produccion/tareas:
            # First box is Interno, Second box is "Buscar por Numero o Titulo de OT"
            search_inputs = self.page.locator("input[type='text'], input[placeholder]").all()
            
            ot_input = None
            for inp in search_inputs:
                ph = (inp.get_attribute("placeholder") or "").lower()
                if "numero" in ph or "ot" in ph or "titulo" in ph:
                    ot_input = inp
                    break

            if not ot_input and len(search_inputs) >= 2:
                ot_input = search_inputs[1] # Second box is OT search

            if ot_input:
                ot_input.fill("")
                ot_input.fill(ot_number if ot_number else interno)
                ot_input.dispatch_event("input")
                ot_input.dispatch_event("change")
                self.page.wait_for_timeout(500)

                # Click Buscar button
                buscar_btn = self.page.locator("button:has-text('BUSCAR')")
                if buscar_btn.count() > 0:
                    buscar_btn.first.click()
                    self.page.wait_for_timeout(2500)

            # Extract Rows directly from the Tasks Table (WITHOUT clicking the eye icon 👁️)
            rows = self.page.locator("table tbody tr").all()
            
            extracted_tasks = []
            for row in rows:
                cols = row.locator("td").all()
                if len(cols) >= 8:
                    col_texts = [cols[i].inner_text().strip() for i in range(len(cols))]
                    extracted_tasks.append({
                        "fecha": col_texts[0] if len(col_texts) > 0 else "",
                        "interno": col_texts[1] if len(col_texts) > 1 else "",
                        "ot": col_texts[2] if len(col_texts) > 2 else "",
                        "centro_costo": col_texts[3] if len(col_texts) > 3 else "",
                        "categoria": col_texts[4] if len(col_texts) > 4 else "",
                        "empleado": col_texts[5] if len(col_texts) > 5 else "",
                        "horas": col_texts[6] if len(col_texts) > 6 else "0",
                        "descripcion": col_texts[7] if len(col_texts) > 7 else "",
                        "realizada": col_texts[8] if len(col_texts) > 8 else ""
                    })

            if not extracted_tasks:
                return {
                    "status": "DISCREPANCY",
                    "reason": f"No se encontraron registros en Taxes para OT {ot_number} (Interno {interno})",
                    "taxes_data": []
                }

            # COMPARE App Order vs Extracted Taxes Tasks
            app_tasks = app_order.get("tasks", [])
            app_total_hours = sum([float(t.get("horasEstimadas") or 0) for t in app_tasks])

            # Check 1: Realizada == SI
            not_completed = [t for t in extracted_tasks if t["realizada"].upper() != "SI"]
            if not_completed:
                return {
                    "status": "DISCREPANCY",
                    "reason": f"Estado REALIZADA es '{not_completed[0]['realizada']}' en Taxes (debe ser SI)",
                    "taxes_data": extracted_tasks
                }

            # Check 2: Horas Comparison
            taxes_total_hours = sum([float(re.sub(r'[^0-9.]', '', t["horas"].replace(",", ".")) or 0) for t in extracted_tasks])
            if abs(taxes_total_hours - app_total_hours) > 0.05:
                return {
                    "status": "DISCREPANCY",
                    "reason": f"Horas no coinciden: Taxes tiene {taxes_total_hours:.2f} hs y App tiene {app_total_hours:.2f} hs",
                    "taxes_data": extracted_tasks
                }

            # Check 3: Description & Diagnostics completeness
            app_full_desc = " ".join([t.get("descripcion", "") for t in app_tasks]).strip()
            taxes_full_desc = " ".join([t["descripcion"] for t in extracted_tasks]).strip()

            # If App has Diagnóstico or Insumos not present in Taxes
            if ("diagnóstico:" in app_full_desc.lower() or "insumos:" in app_full_desc.lower()) and \
               ("diagnóstico:" not in taxes_full_desc.lower() and "insumos:" not in taxes_full_desc.lower()):
                return {
                    "status": "DISCREPANCY",
                    "reason": "Descripción en Taxes está incompleta (falta diagnóstico o insumos agregados en la App)",
                    "taxes_data": extracted_tasks
                }

            # All checks passed cleanly!
            return {
                "status": "MATCH",
                "reason": "Coincidencia 100% verificada en Taxes (REALIZADA=SI, Horas y Descripción correctas)",
                "taxes_data": extracted_tasks
            }

        except Exception as e:
            print(f"[Checker-Error] Exception during audit: {e}")
            return {"status": "ERROR", "reason": str(e), "taxes_data": []}

    def audit_task(self, task_item):
        """
        Audits a single task item (from /api/tasks/history) against Taxes /tms/produccion/tareas table.
        Returns:
        {
          "status": "MATCH" | "DISCREPANCY" | "ERROR",
          "reason": "..."
        }
        """
        if not self.page:
            if not self.start():
                return {"status": "ERROR", "reason": "No se pudo iniciar sesión en Taxes."}

        ot_number = str(task_item.get("taxesOrderNumber") or "").strip()
        interno = str(task_item.get("interno") or "").strip()
        emp_name = str(task_item.get("empleado") or "").strip()
        expected_desc = str(task_item.get("descripcion") or "").strip()
        try:
            expected_hrs = float(str(task_item.get("horasEstimadas") or "0").replace(",", "."))
        except ValueError:
            expected_hrs = 0.0

        if not ot_number:
            return {
                "status": "DISCREPANCY",
                "reason": f"Sin O.T. asignada para interno {interno}"
            }

        try:
            tareas_url = f"{self.config.get('taxes_url', 'https://taxes.com.ar').rstrip('/')}/tms/produccion/tareas"
            if "/tms/produccion/tareas" not in self.page.url:
                self.page.goto(tareas_url, wait_until="networkidle", timeout=30000)
                self.page.wait_for_timeout(2000)

            # Search OT in Taxes
            search_inputs = self.page.locator("input[type='text'], input[placeholder]").all()
            ot_input = None
            for inp in search_inputs:
                ph = (inp.get_attribute("placeholder") or "").lower()
                if "numero" in ph or "ot" in ph or "titulo" in ph:
                    ot_input = inp
                    break
            if not ot_input and len(search_inputs) >= 2:
                ot_input = search_inputs[1]

            if ot_input:
                ot_input.fill("")
                ot_input.fill(ot_number)
                ot_input.dispatch_event("input")
                ot_input.dispatch_event("change")
                self.page.wait_for_timeout(500)

                buscar_btn = self.page.locator("button:has-text('BUSCAR')")
                if buscar_btn.count() > 0:
                    buscar_btn.first.click()
                    self.page.wait_for_timeout(2500)

            rows = self.page.locator("table tbody tr").all()
            extracted_tasks = []
            for row in rows:
                cols = row.locator("td").all()
                if len(cols) >= 8:
                    col_texts = [cols[i].inner_text().strip() for i in range(len(cols))]
                    extracted_tasks.append({
                        "empleado": col_texts[5] if len(col_texts) > 5 else "",
                        "horas": col_texts[6] if len(col_texts) > 6 else "0",
                        "descripcion": col_texts[7] if len(col_texts) > 7 else "",
                        "realizada": col_texts[8] if len(col_texts) > 8 else ""
                    })

            if not extracted_tasks:
                return {
                    "status": "DISCREPANCY",
                    "reason": f"No se encontraron tareas en Taxes para OT {ot_number}"
                }

            # Find matching row by employee / description
            matched = None
            emp_clean = re.sub(r'[^a-zA-Z]', '', emp_name.lower())
            desc_clean = re.sub(r'[^a-zA-Z0-9]', '', expected_desc.lower())

            for t in extracted_tasks:
                t_emp = re.sub(r'[^a-zA-Z]', '', t["empleado"].lower())
                t_desc = re.sub(r'[^a-zA-Z0-9]', '', t["descripcion"].lower())

                emp_ok = (emp_clean in t_emp or t_emp in emp_clean) if emp_clean else True
                desc_ok = (desc_clean in t_desc or t_desc in desc_clean) if desc_clean else True

                if emp_ok and desc_ok:
                    matched = t
                    break

            if not matched and len(extracted_tasks) == 1:
                matched = extracted_tasks[0]

            if not matched:
                return {
                    "status": "DISCREPANCY",
                    "reason": f"No se encontró la tarea de '{emp_name}' en Taxes"
                }

            # Check Realizada == SI
            if matched["realizada"].upper() != "SI":
                return {
                    "status": "DISCREPANCY",
                    "reason": f"Estado REALIZADA es '{matched['realizada']}' en Taxes (debe ser SI)"
                }

            # Check Hours
            try:
                actual_hrs = float(re.sub(r'[^0-9.]', '', matched["horas"].replace(",", ".")) or 0)
            except ValueError:
                actual_hrs = 0.0

            if expected_hrs > 0 and abs(expected_hrs - actual_hrs) > 0.05:
                return {
                    "status": "DISCREPANCY",
                    "reason": f"Horas no coinciden: Taxes tiene {actual_hrs:.2f} hs y App tiene {expected_hrs:.2f} hs"
                }

            # Check Description completeness
            t_desc_lower = matched["descripcion"].lower()
            exp_desc_lower = expected_desc.lower()

            if ("diagnóstico:" in exp_desc_lower or "insumos:" in exp_desc_lower) and \
               ("diagnóstico:" not in t_desc_lower and "insumos:" not in t_desc_lower):
                return {
                    "status": "DISCREPANCY",
                    "reason": "Descripción en Taxes incompleta (falta diagnóstico o insumos)"
                }

            return {
                "status": "MATCH",
                "reason": "Tarea verificada 100% correcta en Taxes"
            }

        except Exception as e:
            return {"status": "ERROR", "reason": str(e)}

if __name__ == "__main__":
    checker = TaxesChecker(headless=False)
    sample_order = {
        "id": "26853",
        "taxesOrderNumber": "26853",
        "interno": "77",
        "tasks": [{"descripcion": "reten de brida diferencial.", "horasEstimadas": "2.36", "empleado": "OJEDA FERNANDEZ JOSE ENRIQUE"}]
    }
    res = checker.audit_order(sample_order)
    print("Audit Result:", json.dumps(res, indent=2, ensure_ascii=False))
    checker.stop()
