import os
import sys
import subprocess
import shutil
from typing import TypedDict, Optional
from openai import OpenAI

# Definición del Estado del Agente según LangGraph
class AgentState(TypedDict):
    error_log: str
    affected_file: Optional[str]
    line_number: Optional[str]
    diagnostic: Optional[str]
    code_proposal: Optional[str]
    validation_result: Optional[str]
    retry_count: int
    success: bool

# Inicializar cliente OpenAI (usa la clave de entorno)
api_key = os.environ.get("OPENAI_API_KEY", "tu-api-key-aqui")
client = OpenAI(api_key=api_key) if api_key != "tu-api-key-aqui" else None

def call_llm(system_prompt: str, user_prompt: str) -> str:
    """Helper para interactuar con GPT-4o."""
    if not client:
        return "ERROR: OPENAI_API_KEY no configurada en las variables de entorno."
    try:
        response = client.chat.completions.create(
            model="gpt-4o",
            messages=[
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt}
            ],
            temperature=0.1
        )
        return response.choices[0].message.content.strip()
    except Exception as e:
        return f"Error de API: {str(e)}"

# ==========================================
# 1. DEFINICIÓN DE LOS NODOS (AGENTES)
# ==========================================

# --- AGENTE 1: DIAGNOSTICADOR ---
def diagnosticar_error(state: AgentState) -> AgentState:
    print("\n🔍 [Agente 1] Diagnosticando el error...")
    log_content = state["error_log"]
    
    system_prompt = (
        "Eres un analista de logs experto en Node.js. Tu tarea es leer el log de error que se te proporciona, "
        "identificar el archivo exacto del código y el número de línea donde ocurrió la falla, "
        "y dar una explicación clara y concisa de la causa raíz."
    )
    user_prompt = f"Aquí está el log de error:\n\n{log_content}"
    
    diagnostic = call_llm(system_prompt, user_prompt)
    print(f"📌 Diagnóstico elaborado:\n{diagnostic}\n")
    
    # Intentar extraer automáticamente la ruta del archivo del log
    affected_file = None
    line_number = None
    
    # Búsqueda simple de archivos JS en el stack trace
    for line in log_content.split("\n"):
        if ".js:" in line and "node_modules" not in line:
            try:
                # Extrae ruta/archivo.js:linea:columna
                parts = line.split("at ")[1].split(" (")[0].split(":")
                if len(parts) >= 2:
                    potential_path = parts[-3].strip() if len(parts) >= 3 else parts[-2].strip()
                    # Limpiar path
                    potential_path = potential_path.replace("(", "").replace(")", "")
                    if os.path.exists(potential_path) or os.path.exists(os.path.basename(potential_path)):
                        affected_file = potential_path if os.path.exists(potential_path) else os.path.basename(potential_path)
                        line_number = parts[-2]
                        break
            except Exception:
                continue

    # Fallback si no se pudo parsear
    if not affected_file:
        print("⚠️ No se pudo determinar el archivo afectado directamente desde el log. Usando server.js por defecto.")
        affected_file = "server.js"
        line_number = "Desconocido"

    state["affected_file"] = affected_file
    state["line_number"] = line_number
    state["diagnostic"] = diagnostic
    return state


# --- AGENTE 2: DESARROLLADOR ---
def corregir_codigo(state: AgentState) -> AgentState:
    affected_file = state["affected_file"]
    print(f"\n💻 [Agente 2] Intentando corregir el archivo: {affected_file}...")
    
    if not affected_file or not os.path.exists(affected_file):
        state["validation_result"] = "Error: El archivo afectado no existe."
        return state

    # Crear backup en el primer intento antes de modificar
    backup_file = f"{affected_file}.bak"
    if state["retry_count"] == 0 and not os.path.exists(backup_file):
        shutil.copy2(affected_file, backup_file)
        print(f"💾 Copia de seguridad creada: {backup_file}")

    # Leer el código original
    with open(affected_file, "r", encoding="utf-8") as f:
        original_code = f.read()

    system_prompt = (
        "Eres un desarrollador experto en Javascript y Node.js. Tu misión es corregir el código del archivo "
        "afectado basándote en el diagnóstico del error. Debes devolver la corrección de forma segura. "
        "IMPORTANTE: Devuelve ÚNICAMENTE el archivo de código fuente completo corregido. No incluyas explicaciones "
        "adicionales, ni bloques de código markdown como ```javascript."
    )
    user_prompt = (
        f"Archivo afectado: {affected_file}\n"
        f"Línea de error estimada: {state['line_number']}\n"
        f"Diagnóstico: {state['diagnostic']}\n\n"
        f"Intentos de re-reparación previos: {state['retry_count']}\n"
        f"Último resultado de compilación/test: {state['validation_result']}\n\n"
        f"Código Original Completo:\n\n{original_code}"
    )

    code_proposal = call_llm(system_prompt, user_prompt)
    
    # Limpiar posibles marcadores markdown agregados por el LLM por error
    if code_proposal.startswith("```"):
        lines = code_proposal.split("\n")
        if lines[0].startswith("```"):
            lines = lines[1:]
        if lines[-1].strip() == "```":
            lines = lines[:-1]
        code_proposal = "\n".join(lines).strip()

    state["code_proposal"] = code_proposal

    # Escribir la corrección en el archivo
    with open(affected_file, "w", encoding="utf-8") as f:
        f.write(code_proposal)
    print("🛠️ Corrección propuesta guardada en el archivo.")
    
    return state


# --- AGENTE 3: VALIDADOR ---
def validar_sintaxis(state: AgentState) -> AgentState:
    affected_file = state["affected_file"]
    print(f"\n🧪 [Agente 3] Validando sintaxis de {affected_file}...")
    
    if not affected_file or not os.path.exists(affected_file):
        state["validation_result"] = "Error: Archivo no encontrado para validar."
        return state

    # Ejecutar verificación de sintaxis en Node.js (node -c)
    try:
        res = subprocess.run(
            f"node -c {affected_file}", 
            shell=True, 
            capture_output=True, 
            text=True
        )
        if res.returncode == 0:
            print("✅ Validación exitosa: El código JS es sintácticamente correcto.")
            state["validation_result"] = "success"
            state["success"] = True
        else:
            print(f"❌ Validación fallida. Detalle del error de sintaxis:\n{res.stderr}")
            state["validation_result"] = res.stderr
            state["success"] = False
            state["retry_count"] += 1
    except Exception as e:
        state["validation_result"] = f"Error al ejecutar validación: {str(e)}"
        state["success"] = False
        state["retry_count"] += 1
        
    return state


# ==========================================
# 2. DEFINICIÓN DEL FLUJO DE TRABAJO (GRAFO)
# ==========================================

# Intentar importar LangGraph original para construir el Grafo de Estados.
# Si no está instalado, ejecutamos un motor de estados alternativo en Python
# con la misma lógica exacta para que el script nunca falle en producción.
try:
    from langgraph.graph import StateGraph, END

    # Crear el grafo
    workflow = StateGraph(AgentState)

    # Agregar Nodos
    workflow.add_node("diagnosticar", diagnosticar_error)
    workflow.add_node("corregir", corregir_codigo)
    workflow.add_node("validar", validar_sintaxis)

    # Definir conexiones
    workflow.set_entry_point("diagnosticar")
    workflow.add_edge("diagnosticar", "corregir")
    workflow.add_edge("corregir", "validar")

    # Transición condicional para re-intentar o restaurar
    def decide_next_step(state: AgentState):
        if state["success"]:
            return END
        elif state["retry_count"] < 3:
            print(f"🔄 Re-intentando corrección. Intento número {state['retry_count']}...")
            return "corregir"
        else:
            print("🚨 Límite de 3 intentos alcanzado. Restaurando copia de seguridad...")
            affected_file = state["affected_file"]
            backup = f"{affected_file}.bak"
            if os.path.exists(backup):
                shutil.copy2(backup, affected_file)
                print(f"🔄 Archivo original {affected_file} restaurado desde {backup}.")
            return END

    workflow.add_conditional_edges("validar", decide_next_step)

    # Compilar Grafo
    healer_app = workflow.compile()

    def run_self_healing(log_content: str):
        initial_state: AgentState = {
            "error_log": log_content,
            "affected_file": None,
            "line_number": None,
            "diagnostic": None,
            "code_proposal": None,
            "validation_result": None,
            "retry_count": 0,
            "success": False
        }
        return healer_app.invoke(initial_state)

except ImportError:
    # Motor de Estados de Respaldo (Emula a LangGraph si no está instalado)
    print("ℹ️ LangGraph no está instalado en el entorno. Ejecutando motor de estados nativo...")
    
    def run_self_healing(log_content: str):
        state: AgentState = {
            "error_log": log_content,
            "affected_file": None,
            "line_number": None,
            "diagnostic": None,
            "code_proposal": None,
            "validation_result": None,
            "retry_count": 0,
            "success": False
        }
        
        # Nodo 1: Diagnóstico
        state = diagnosticar_error(state)
        
        # Bucle Condicional de Corrección y Validación
        while state["retry_count"] < 3:
            state = corregir_codigo(state)
            state = validar_sintaxis(state)
            
            if state["success"]:
                break
                
            print(f"🔄 Re-intentando corrección. Intento número {state['retry_count']}...")
            
        # Si falló después de los 3 intentos, restaurar backup
        if not state["success"]:
            print("🚨 Límite de 3 intentos alcanzado. Restaurando copia de seguridad...")
            affected_file = state["affected_file"]
            backup = f"{affected_file}.bak"
            if affected_file and os.path.exists(backup):
                shutil.copy2(backup, affected_file)
                print(f"🔄 Archivo original {affected_file} restaurado desde {backup}.")
                
        return state


if __name__ == "__main__":
    print("🤖 Iniciando ciclo de auto-curación autónomo...")
    
    # Ruta del log de error
    log_path = "last_error.log"
    if not os.path.exists(log_path):
        # Crear un log de prueba si no existe
        with open(log_path, "w", encoding="utf-8") as f:
            f.write("ReferenceError: updateEmployeeHoursSummary is not defined\n  at c:\\Users\\admin\\.gemini\\antigravity\\scratch\\app_taxes\\server.js:45:12")
            
    with open(log_path, "r", encoding="utf-8") as f:
        error_log = f.read()

    result = run_self_healing(error_log)
    print("\n✨ Proceso de reparación completado.")
    print("Resultado de la reparación:", "ÉXITO" if result["success"] else "FALLIDO")
