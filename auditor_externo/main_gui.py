import os
import sys
import json
import time
import threading
import tkinter as tk
from tkinter import ttk, messagebox
import customtkinter as ctk

from auditor_db import AuditorDB
from app_client import AppClient
from taxes_checker import TaxesChecker

ctk.set_appearance_mode("dark")
ctk.set_default_color_theme("blue")

class AuditorApp(ctk.CTk):
    def __init__(self):
        super().__init__()

        self.title("Control de Auditoría y Órdenes - Taxes")
        self.geometry("1180x740")
        self.minsize(950, 620)

        self.db = AuditorDB()
        self.client = AppClient()
        self.checker = None
        self.is_auditing = False

        self._create_ui()
        self.refresh_tables()

    def _get_order_sector(self, order):
        cls = str(order.get("clasificacion") or "").lower()
        if "herreria" in cls:
            return "Herrería"
        elif "edilic" in cls:
            return "Edilicio"
        return "Taller"

    def _create_ui(self):
        # --- Top Header ---
        self.header_frame = ctk.CTkFrame(self, fg_color="#0f172a", corner_radius=0)
        self.header_frame.pack(fill="x", side="top", ipady=10)

        self.title_label = ctk.CTkLabel(
            self.header_frame,
            text="⚡ MONITOR DE AUDITORÍA Y CONTROL DE ÓRDENES",
            font=ctk.CTkFont(size=20, weight="bold"),
            text_color="#f8fafc"
        )
        self.title_label.pack(side="left", padx=20, pady=5)

        self.status_badge = ctk.CTkLabel(
            self.header_frame,
            text="🟢 Listo / En Línea",
            font=ctk.CTkFont(size=13, weight="bold"),
            text_color="#10b981",
            fg_color="#064e3b",
            corner_radius=6,
            padx=12, pady=4
        )
        self.status_badge.pack(side="right", padx=20)

        # --- Control Bar ---
        self.ctrl_frame = ctk.CTkFrame(self, fg_color="#1e293b", corner_radius=8)
        self.ctrl_frame.pack(fill="x", padx=15, pady=10)

        self.btn_start = ctk.CTkButton(
            self.ctrl_frame,
            text="▷ Iniciar Auditoría",
            font=ctk.CTkFont(size=14, weight="bold"),
            fg_color="#2563eb",
            hover_color="#1d4ed8",
            width=150,
            command=self.start_audit_thread
        )
        self.btn_start.pack(side="left", padx=10, pady=10)

        self.btn_stop = ctk.CTkButton(
            self.ctrl_frame,
            text="🛑 Detener",
            font=ctk.CTkFont(size=14, weight="bold"),
            fg_color="#ef4444",
            hover_color="#dc2626",
            width=110,
            state="disabled",
            command=self.stop_audit
        )
        self.btn_stop.pack(side="left", padx=5, pady=10)

        self.btn_resync_all = ctk.CTkButton(
            self.ctrl_frame,
            text="🔄 Resincronizar Discrepancias",
            font=ctk.CTkFont(size=14, weight="bold"),
            fg_color="#2563eb",
            hover_color="#1d4ed8",
            width=210,
            command=self.resync_discrepancies_thread
        )
        self.btn_resync_all.pack(side="left", padx=10, pady=10)

        # Sector Selector Dropdown
        self.lbl_sector = ctk.CTkLabel(
            self.ctrl_frame,
            text="Sector:",
            font=ctk.CTkFont(size=13, weight="bold"),
            text_color="#94a3b8"
        )
        self.lbl_sector.pack(side="left", padx=(15, 5), pady=10)

        self.combo_sector = ctk.CTkOptionMenu(
            self.ctrl_frame,
            values=["Todos los Sectores", "Taller (Mecánica)", "Herrería", "Edilicio"],
            font=ctk.CTkFont(size=13, weight="bold"),
            fg_color="#334155",
            button_color="#475569",
            button_hover_color="#64748b",
            dropdown_fg_color="#1e293b",
            dropdown_hover_color="#334155",
            width=180
        )
        self.combo_sector.set("Todos los Sectores")
        self.combo_sector.pack(side="left", padx=5, pady=10)

        self.btn_refresh = ctk.CTkButton(
            self.ctrl_frame,
            text="🔃 Actualizar Tablas",
            font=ctk.CTkFont(size=13),
            fg_color="#475569",
            hover_color="#334155",
            width=130,
            command=self.refresh_tables
        )
        self.btn_refresh.pack(side="right", padx=10, pady=10)

        # --- Main Tabview ---
        self.tabview = ctk.CTkTabview(self, corner_radius=8)
        self.tabview.pack(fill="both", expand=True, padx=15, pady=5)

        self.tab_borradas = self.tabview.add("🗑️ Órdenes Borradas (Auditadas OK)")
        self.tab_resync = self.tabview.add("⚠️ Órdenes Resincronizadas (Con Discrepancia)")
        self.tab_tareas = self.tabview.add("📌 Tareas (Historial)")

        self._build_borradas_tab()
        self._build_resync_tab()
        self._build_tareas_tab()

        # --- Log Console ---
        self.log_frame = ctk.CTkFrame(self, fg_color="#0f172a", height=120)
        self.log_frame.pack(fill="x", side="bottom", padx=15, pady=10)

        self.log_label = ctk.CTkLabel(self.log_frame, text="Registro de Eventos en Vivo:", font=ctk.CTkFont(size=12, weight="bold"), text_color="#94a3b8")
        self.log_label.pack(anchor="w", padx=10, pady=(5, 2))

        self.log_text = ctk.CTkTextbox(self.log_frame, height=80, fg_color="#1e293b", text_color="#38bdf8", font=ctk.CTkFont(family="Consolas", size=12))
        self.log_text.pack(fill="both", expand=True, padx=10, pady=(0, 5))

    def log(self, message):
        """Appends a log message to the log text box."""
        timestamp = time.strftime("%H:%M:%S")
        formatted = f"[{timestamp}] {message}\n"
        self.log_text.insert("end", formatted)
        self.log_text.see("end")

    def _build_borradas_tab(self):
        style = ttk.Style()
        style.theme_use("clam")
        style.configure("Treeview", background="#1e293b", foreground="#f8fafc", fieldbackground="#1e293b", rowheight=28, borderwidth=0)
        style.configure("Treeview.Heading", background="#0f172a", foreground="#38bdf8", font=("Inter", 10, "bold"))
        style.map("Treeview", background=[("selected", "#3b82f6")])

        cols = ("fecha", "ot", "interno", "sector", "empleado", "horas", "descripcion", "realizada")
        self.tree_borradas = ttk.Treeview(self.tab_borradas, columns=cols, show="headings", selectmode="browse")

        self.tree_borradas.heading("fecha", text="Fecha Borrado")
        self.tree_borradas.heading("ot", text="Nº O.T.")
        self.tree_borradas.heading("interno", text="Interno")
        self.tree_borradas.heading("sector", text="Sector")
        self.tree_borradas.heading("empleado", text="Empleado")
        self.tree_borradas.heading("horas", text="Horas")
        self.tree_borradas.heading("descripcion", text="Descripción")
        self.tree_borradas.heading("realizada", text="Realizada")

        self.tree_borradas.column("fecha", width=140, anchor="center")
        self.tree_borradas.column("ot", width=90, anchor="center")
        self.tree_borradas.column("interno", width=80, anchor="center")
        self.tree_borradas.column("sector", width=100, anchor="center")
        self.tree_borradas.column("empleado", width=170, anchor="w")
        self.tree_borradas.column("horas", width=70, anchor="center")
        self.tree_borradas.column("descripcion", width=340, anchor="w")
        self.tree_borradas.column("realizada", width=80, anchor="center")

        scrollbar = ttk.Scrollbar(self.tab_borradas, orient="vertical", command=self.tree_borradas.yview)
        self.tree_borradas.configure(yscrollcommand=scrollbar.set)

        self.tree_borradas.pack(side="left", fill="both", expand=True, padx=5, pady=5)
        scrollbar.pack(side="right", fill="y", pady=5)

    def _build_resync_tab(self):
        cols = ("fecha", "ot", "interno", "sector", "empleado", "horas", "observacion")
        self.tree_resync = ttk.Treeview(self.tab_resync, columns=cols, show="headings", selectmode="browse")

        self.tree_resync.heading("fecha", text="Fecha Resincro")
        self.tree_resync.heading("ot", text="Nº O.T.")
        self.tree_resync.heading("interno", text="Interno")
        self.tree_resync.heading("sector", text="Sector")
        self.tree_resync.heading("empleado", text="Empleado")
        self.tree_resync.heading("horas", text="Horas (App / Taxes)")
        self.tree_resync.heading("observacion", text="Motivo / Observación de Resincronización")

        self.tree_resync.column("fecha", width=140, anchor="center")
        self.tree_resync.column("ot", width=90, anchor="center")
        self.tree_resync.column("interno", width=80, anchor="center")
        self.tree_resync.column("sector", width=100, anchor="center")
        self.tree_resync.column("empleado", width=170, anchor="w")
        self.tree_resync.column("horas", width=130, anchor="center")
        self.tree_resync.column("observacion", width=400, anchor="w")

        scrollbar = ttk.Scrollbar(self.tab_resync, orient="vertical", command=self.tree_resync.yview)
        self.tree_resync.configure(yscrollcommand=scrollbar.set)

        self.tree_resync.pack(side="left", fill="both", expand=True, padx=5, pady=5)
        scrollbar.pack(side="right", fill="y", pady=5)

    def _build_tareas_tab(self):
        bar = ctk.CTkFrame(self.tab_tareas, fg_color="transparent")
        bar.pack(fill="x", padx=5, pady=(5, 0))

        btn_audit_tasks = ctk.CTkButton(
            bar,
            text="⚡ Controlar Tareas en Taxes",
            font=ctk.CTkFont(size=13, weight="bold"),
            fg_color="#0284c7",
            hover_color="#0369a1",
            width=200,
            command=self.start_task_audit_thread
        )
        btn_audit_tasks.pack(side="left", padx=5)

        btn_lock = ctk.CTkButton(
            bar,
            text="🔒 Cerrar Candado",
            font=ctk.CTkFont(size=12),
            fg_color="#334155",
            hover_color="#475569",
            width=130,
            command=self.lock_selected_task
        )
        btn_lock.pack(side="left", padx=5)

        btn_resync = ctk.CTkButton(
            bar,
            text="🔄 Resincronizar Orden",
            font=ctk.CTkFont(size=12, weight="bold"),
            fg_color="#2563eb",
            hover_color="#1d4ed8",
            width=150,
            command=self.resync_selected_task
        )
        btn_resync.pack(side="left", padx=5)

        cols = ("ot", "interno", "sector", "empleado", "horas", "descripcion", "insumos")
        self.tree_tareas = ttk.Treeview(self.tab_tareas, columns=cols, show="headings", selectmode="browse")

        self.tree_tareas.heading("ot", text="Nº O.T.")
        self.tree_tareas.heading("interno", text="Interno")
        self.tree_tareas.heading("sector", text="Sector")
        self.tree_tareas.heading("empleado", text="Empleado")
        self.tree_tareas.heading("horas", text="Horas")
        self.tree_tareas.heading("descripcion", text="Descripción")
        self.tree_tareas.heading("insumos", text="Insumos / Diagnóstico")

        self.tree_tareas.column("ot", width=90, anchor="center")
        self.tree_tareas.column("interno", width=80, anchor="center")
        self.tree_tareas.column("sector", width=100, anchor="center")
        self.tree_tareas.column("empleado", width=170, anchor="w")
        self.tree_tareas.column("horas", width=70, anchor="center")
        self.tree_tareas.column("descripcion", width=340, anchor="w")
        self.tree_tareas.column("insumos", width=220, anchor="w")

        scrollbar = ttk.Scrollbar(self.tab_tareas, orient="vertical", command=self.tree_tareas.yview)
        self.tree_tareas.configure(yscrollcommand=scrollbar.set)

        self.tree_tareas.pack(side="left", fill="both", expand=True, padx=5, pady=5)
        scrollbar.pack(side="right", fill="y", pady=5)

    def refresh_tables(self):
        selected_sector = self.combo_sector.get() if hasattr(self, 'combo_sector') else "Todos los Sectores"

        # Refresh Borradas Treeview
        for item in self.tree_borradas.get_children():
            self.tree_borradas.delete(item)
        
        borradas = self.db.get_ordenes_borradas()
        filtered_borradas = []
        for b in borradas:
            sec = self._get_order_sector(b)
            if selected_sector == "Todos los Sectores" or \
               (selected_sector == "Herrería" and sec == "Herrería") or \
               (selected_sector == "Edilicio" and sec == "Edilicio") or \
               (selected_sector == "Taller (Mecánica)" and sec == "Taller"):
                filtered_borradas.append(b)
                self.tree_borradas.insert("", "end", values=(
                    b.get("fechaBorrado", "-"),
                    b.get("numeroOrden", "-"),
                    b.get("interno", "-"),
                    sec,
                    b.get("empleado", "-"),
                    b.get("horas", "-"),
                    b.get("descripcion", "-"),
                    b.get("realizada", "SI")
                ))

        # Refresh Resincronizadas Treeview
        for item in self.tree_resync.get_children():
            self.tree_resync.delete(item)

        resyncs = self.db.get_ordenes_resincronizadas()
        filtered_resyncs = []
        for r in resyncs:
            sec = self._get_order_sector(r)
            if selected_sector == "Todos los Sectores" or \
               (selected_sector == "Herrería" and sec == "Herrería") or \
               (selected_sector == "Edilicio" and sec == "Edilicio") or \
               (selected_sector == "Taller (Mecánica)" and sec == "Taller"):
                filtered_resyncs.append(r)
                horas_str = f"App: {r.get('horasApp','-')} / Taxes: {r.get('horasTaxes','-')}"
                self.tree_resync.insert("", "end", values=(
                    r.get("fechaResincronizado", "-"),
                    r.get("numeroOrden", "-"),
                    r.get("interno", "-"),
                    sec,
                    r.get("empleado", "-"),
                    horas_str,
                    r.get("observacion", "-")
                ))

        # Refresh Tareas Treeview
        tasks_count = 0
        if hasattr(self, 'tree_tareas'):
            for item in self.tree_tareas.get_children():
                self.tree_tareas.delete(item)

            tasks = self.client.fetch_task_history()
            for t in tasks:
                sec = t.get("clasificacion") or "Taller"
                if selected_sector == "Todos los Sectores" or \
                   (selected_sector == "Herrería" and "herreria" in sec.lower()) or \
                   (selected_sector == "Edilicio" and "edilic" in sec.lower()) or \
                   (selected_sector == "Taller (Mecánica)" and ("taller" in sec.lower() or "correctiv" in sec.lower() or "preventiv" in sec.lower())):
                    tasks_count += 1
                    ot = t.get("taxesOrderNumber") or t.get("orderId") or "-"
                    task_id = t.get("taskId") or t.get("id") or f"t-{tasks_count}"
                    order_id = t.get("orderId") or f"o-{tasks_count}"
                    item_iid = f"{order_id}::{task_id}"
                    self.tree_tareas.insert("", "end", values=(
                        ot,
                        t.get("interno", "-"),
                        sec,
                        t.get("empleado", "-"),
                        t.get("horasEstimadas", "0"),
                        t.get("descripcion", "-"),
                        t.get("insumos", "-")
                    ), iid=item_iid)

        self.log(f"Tablas actualizadas ({selected_sector}): {len(filtered_borradas)} borradas auditadas, {len(filtered_resyncs)} resincronizadas, {tasks_count} tareas de historial.")

    def start_audit_thread(self):
        if self.is_auditing:
            return
        self.is_auditing = True
        self.btn_start.configure(state="disabled")
        self.btn_stop.configure(state="normal")
        self.status_badge.configure(text="🟡 Ejecutando Auditoría...", text_color="#f59e0b", fg_color="#451a03")
        
        t = threading.Thread(target=self._run_audit_process, daemon=True)
        t.start()

    def stop_audit(self):
        self.is_auditing = False
        self.log("Solicitud de detención enviada. Finalizando ciclo...")
        self.btn_stop.configure(state="disabled")
        self.btn_start.configure(state="normal")
        self.status_badge.configure(text="🟢 Listo / En Línea", text_color="#10b981", fg_color="#064e3b")

    def _run_audit_process(self):
        selected_sector = self.combo_sector.get()
        self.log(f"Obteniendo lista de órdenes desde Railway para: {selected_sector}...")
        orders = self.client.fetch_orders()
        
        if not orders:
            self.log("⚠️ No se obtuvieron órdenes o no hay respuesta del servidor.")
            self.stop_audit()
            return

        to_audit = []
        for o in orders:
            if o.get("deleted"):
                continue
            sec = self._get_order_sector(o)
            if selected_sector == "Todos los Sectores":
                to_audit.append(o)
            elif selected_sector == "Herrería" and sec == "Herrería":
                to_audit.append(o)
            elif selected_sector == "Edilicio" and sec == "Edilicio":
                to_audit.append(o)
            elif selected_sector == "Taller (Mecánica)" and sec == "Taller":
                to_audit.append(o)

        self.log(f"Se encontraron {len(to_audit)} órdenes ({selected_sector}) para inspeccionar.")

        self.checker = TaxesChecker(headless=True)
        if not self.checker.start():
            self.log("❌ Error iniciando sesión en Taxes.")
            self.stop_audit()
            return

        for idx, order in enumerate(to_audit, 1):
            if not self.is_auditing:
                break

            ot = order.get("taxesOrderNumber") or order.get("id")
            interno = order.get("interno")
            sec = self._get_order_sector(order)
            self.log(f"[{idx}/{len(to_audit)}] Inspeccionando OT {ot} (Interno {interno} - {sec})...")

            result = self.checker.audit_order(order)
            status = result.get("status")
            reason = result.get("reason", "")

            tasks = order.get("tasks", [])
            emp = tasks[0].get("empleado", "N/A") if tasks else "N/A"
            hrs = tasks[0].get("horasEstimadas", "0") if tasks else "0"
            desc = tasks[0].get("descripcion", "N/A") if tasks else "N/A"

            if status == "MATCH":
                self.log(f"  ✅ OT {ot} ({sec}) coincide 100%. Registrando en Borradas Auditadas...")
                self.db.add_orden_borrada({
                    "numeroOrden": ot,
                    "interno": interno,
                    "empleado": emp,
                    "horas": hrs,
                    "descripcion": desc,
                    "clasificacion": order.get("clasificacion", sec),
                    "realizada": "SI",
                    "tasks": tasks
                })
                # Soft delete in App
                self.client.delete_order(order.get("id"))

            elif status == "DISCREPANCY":
                self.log(f"  ⚠️ OT {ot} ({sec}) DISCREPANCIA: {reason}. Desarchivando y moviendo a órdenes pendientes...")
                # Unarchive & move order back to active pending orders module for editing
                self.client.unarchive_order(order.get("id"))
                
                # Record in Resincronizadas DB
                taxes_data = result.get("taxes_data", [])
                taxes_hrs = taxes_data[0].get("horas", "0") if taxes_data else "0"
                self.db.add_orden_resincronizada({
                    "numeroOrden": ot,
                    "interno": interno,
                    "empleado": emp,
                    "horasApp": hrs,
                    "horasTaxes": taxes_hrs,
                    "descripcion": desc,
                    "clasificacion": order.get("clasificacion", sec),
                    "realizada": "NO",
                    "observacion": reason,
                    "tasks": tasks
                })
            else:
                self.log(f"  ❌ Error inspeccionando OT {ot}: {reason}")

            self.after(0, self.refresh_tables)
            time.sleep(1)

        self.checker.stop()
        self.log(f"✅ Auditoría de {selected_sector} completada.")
        self.after(0, self.stop_audit)

    def resync_discrepancies_thread(self):
        t = threading.Thread(target=self._run_resync_all, daemon=True)
        t.start()

    def _run_resync_all(self):
        resyncs = self.db.get_ordenes_resincronizadas()
        self.log(f"Ejecutando resincronización masiva para {len(resyncs)} órdenes...")
        for r in resyncs:
            ot = r.get("numeroOrden")
            self.log(f"Re-enviando señal de resincronización para OT {ot}...")
            # Fetch order ID and resync
            orders = self.client.fetch_orders()
            matching = [o for o in orders if str(o.get("taxesOrderNumber") or o.get("id")) == str(ot)]
            if matching:
                self.client.trigger_resync(matching[0].get("id"))
        self.log("✅ Resincronización masiva finalizada.")

    def start_task_audit_thread(self):
        if self.is_auditing:
            return
        self.is_auditing = True
        self.btn_start.configure(state="disabled")
        self.btn_stop.configure(state="normal")
        self.status_badge.configure(text="🟡 Controlando Tareas...", text_color="#f59e0b", fg_color="#451a03")
        
        t = threading.Thread(target=self._run_task_audit_process, daemon=True)
        t.start()

    def _run_task_audit_process(self):
        selected_sector = self.combo_sector.get()
        self.log(f"Obteniendo tareas del historial desde Railway para: {selected_sector}...")
        tasks = self.client.fetch_task_history()

        if not tasks:
            self.log("⚠️ No hay tareas pendientes de controlar en el historial.")
            self.stop_audit()
            return

        to_audit = []
        for t in tasks:
            sec = t.get("clasificacion") or "Taller"
            if selected_sector == "Todos los Sectores" or \
               (selected_sector == "Herrería" and "herreria" in sec.lower()) or \
               (selected_sector == "Edilicio" and "edilic" in sec.lower()) or \
               (selected_sector == "Taller (Mecánica)" and ("taller" in sec.lower() or "correctiv" in sec.lower() or "preventiv" in sec.lower())):
                to_audit.append(t)

        self.log(f"Se encontraron {len(to_audit)} tareas ({selected_sector}) para controlar en Taxes.")

        self.checker = TaxesChecker(headless=True)
        if not self.checker.start():
            self.log("❌ Error iniciando sesión en Taxes.")
            self.stop_audit()
            return

        for idx, task_item in enumerate(to_audit, 1):
            if not self.is_auditing:
                break

            ot = task_item.get("taxesOrderNumber") or task_item.get("orderId")
            emp = task_item.get("empleado", "N/A")
            hrs = task_item.get("horasEstimadas", "0")
            order_id = task_item.get("orderId")
            task_id = task_item.get("taskId") or task_item.get("id")

            self.log(f"[{idx}/{len(to_audit)}] Inspeccionando Tarea OT {ot} - Operario: {emp} ({hrs} hs)...")

            res = self.checker.audit_task(task_item)
            status = res.get("status")
            reason = res.get("reason", "")

            if status == "MATCH":
                self.log(f"  ✅ Tarea OT {ot} ({emp}) OK en Taxes. Cerrando candado...")
                self.client.lock_task(order_id, task_id)

            elif status == "DISCREPANCY":
                self.log(f"  ⚠️ Tarea OT {ot} DISCREPANCIA: {reason}. Mandando orden a resincronizar (botón azul)...")
                self.client.force_resync(order_id)
            else:
                self.log(f"  ❌ Error en tarea OT {ot}: {reason}")

            self.after(0, self.refresh_tables)
            time.sleep(1)

        self.checker.stop()
        self.log(f"✅ Control de tareas ({selected_sector}) completado.")
        self.after(0, self.stop_audit)

    def lock_selected_task(self):
        sel = self.tree_tareas.selection()
        if not sel:
            messagebox.showwarning("Atención", "Seleccioná una tarea de la tabla de Tareas.")
            return
        item_id = sel[0]
        if "::" in item_id:
            order_id, task_id = item_id.split("::")
            if self.client.lock_task(order_id, task_id):
                self.log(f"🔒 Candado cerrado manualmente para tarea {task_id}")
                self.refresh_tables()
            else:
                messagebox.showerror("Error", "No se pudo cerrar el candado.")

    def resync_selected_task(self):
        sel = self.tree_tareas.selection()
        if not sel:
            messagebox.showwarning("Atención", "Seleccioná una tarea de la tabla de Tareas.")
            return
        item_id = sel[0]
        if "::" in item_id:
            order_id, task_id = item_id.split("::")
            if self.client.force_resync(order_id):
                self.log(f"🔄 Orden {order_id} mandada a resincronizar (botón azul)")
                self.refresh_tables()
            else:
                messagebox.showerror("Error", "No se pudo enviar a resincronizar.")

if __name__ == "__main__":
    app = AuditorApp()
    app.mainloop()
