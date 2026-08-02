import requests
import json
import os
import time

CONFIG_FILE = os.path.join(os.path.dirname(__file__), "config.json")

class AppClient:
    def __init__(self, config_path=CONFIG_FILE):
        self.config_path = config_path
        self.config = self._load_config()
        self.base_url = self.config.get("app_url", "https://app-taxes-production-ec67.up.railway.app").rstrip("/")

    def _load_config(self):
        if os.path.exists(self.config_path):
            try:
                with open(self.config_path, "r", encoding="utf-8") as f:
                    return json.load(f)
            except Exception as e:
                print(f"[Client-Config] Error loading config: {e}")
        return {}

    def fetch_orders(self):
        """Fetches all work orders (active + archived) from backend API with automatic retries."""
        self.config = self._load_config()
        self.base_url = self.config.get("app_url", "https://app-taxes-production-ec67.up.railway.app").rstrip("/")
        url = f"{self.base_url}/api/orders/all"

        for attempt in range(1, 4):
            try:
                resp = requests.get(url, timeout=60)
                if resp.status_code == 200:
                    return resp.json()
                print(f"[Client-Warning] Attempt {attempt}/3: HTTP {resp.status_code} fetching orders from {url}")
            except Exception as e:
                print(f"[Client-Exception] Attempt {attempt}/3 error: {e}")
            if attempt < 3:
                time.sleep(2)
        return []

    def trigger_resync(self, order_id):
        """Triggers resynchronization for a given order ID."""
        try:
            url = f"{self.base_url}/api/orders/{order_id}/resync"
            resp = requests.post(url, timeout=15)
            if resp.status_code in (200, 201):
                return True, resp.json()
            else:
                return False, f"HTTP {resp.status_code}"
        except Exception as e:
            return False, str(e)

    def unarchive_order(self, order_id):
        """Un-archives an order from Historial and moves it back to active pending orders."""
        try:
            url = f"{self.base_url}/api/orders/{order_id}/unarchive"
            resp = requests.patch(url, timeout=15)
            if resp.status_code in (200, 201):
                return True, resp.json()
            else:
                # Fallback to resync
                return self.trigger_resync(order_id)
        except Exception as e:
            return self.trigger_resync(order_id)

    def delete_order(self, order_id):
        """Soft-deletes/removes an order from Railway after clean audit match."""
        try:
            url = f"{self.base_url}/api/orders/{order_id}"
            resp = requests.delete(url, timeout=15)
            if resp.status_code in (200, 204):
                return True
            else:
                return False
        except Exception as e:
            print(f"[Client-Exception] delete_order error: {e}")
            return False

    def fetch_task_history(self):
        """Fetches all unverified finished tasks from backend API."""
        self.config = self._load_config()
        self.base_url = self.config.get("app_url", "https://app-taxes-production-ec67.up.railway.app").rstrip("/")
        url = f"{self.base_url}/api/tasks/history"
        try:
            resp = requests.get(url, timeout=30)
            if resp.status_code == 200:
                return resp.json()
        except Exception as e:
            print(f"[Client-Exception] fetch_task_history error: {e}")
        return []

    def lock_task(self, order_id, task_id):
        """Locks verification for a specific task (closes verification lock)."""
        try:
            url = f"{self.base_url}/api/orders/{order_id}/tasks/{task_id}/lock"
            resp = requests.patch(url, timeout=15)
            return resp.status_code in (200, 201)
        except Exception as e:
            print(f"[Client-Exception] lock_task error: {e}")
            return False

    def force_resync(self, order_id):
        """Forces an order back to active state for re-synchronization (blue button action)."""
        try:
            url = f"{self.base_url}/api/orders/{order_id}/force-resync"
            resp = requests.post(url, timeout=15)
            return resp.status_code in (200, 201)
        except Exception as e:
            print(f"[Client-Exception] force_resync error: {e}")
            return False

if __name__ == "__main__":
    client = AppClient()
    orders = client.fetch_orders()
    print(f"Connected to Railway. Total orders fetched: {len(orders)}")
