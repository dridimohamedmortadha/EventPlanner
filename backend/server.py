import http.server
import socketserver
import json
import urllib.request
import urllib.error
import threading
import os
import sqlite3

DB_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'events.db')

def init_db():
    conn = sqlite3.connect(DB_PATH)
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS events
                 (id INTEGER PRIMARY KEY AUTOINCREMENT,
                  name TEXT,
                  date TEXT,
                  budget INTEGER,
                  expected_attendance INTEGER,
                  extras TEXT,
                  raw_data TEXT)''')
    conn.commit()
    conn.close()

PORT = 3000
N8N_URL = "http://localhost:5678"
CHAT_WEBHOOK_ID = "3af4c488-a56f-42f6-8ae8-3242d6e80b14"
WAIT_WEBHOOK_ID = "8ea06a8b-9ff7-4b6a-b4b9-d84780148952"
PHASE2_WEBHOOK_ID = "chat-phase2"

# Global state to share between webhook from n8n and frontend
app_state = {
    "status": "chatting",  # chatting, awaiting_selection, phase2_chat, completed
    "event": None,
    "extras_options": [],
    "selected_extras": [],
    "thought_process": []
}

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    def _set_headers(self, status=200, content_type="application/json"):
        self.send_response(status)
        self.send_header('Content-type', content_type)
        # Enable CORS
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

    def do_OPTIONS(self):
        self._set_headers()

    def do_GET(self):
        if self.path == '/':
            self.path = '/index.html'
        
        if self.path == '/api/status':
            self._set_headers()
            self.wfile.write(json.dumps(app_state).encode())
            return
            
        if self.path == '/api/dashboard':
            try:
                conn = sqlite3.connect(DB_PATH)
                c = conn.cursor()
                c.execute('SELECT id, name, date, budget, expected_attendance, extras FROM events ORDER BY id DESC')
                rows = c.fetchall()
                conn.close()
                
                events_list = []
                for row in rows:
                    budget_val = row[3] or 0
                    expected = row[4] or 50
                    extras_data = json.loads(row[5]) if row[5] else []
                    
                    # Mock prices for extras
                    extras_breakdown = []
                    total_spent = 0
                    for extra in extras_data:
                        price = int(budget_val * 0.15) if budget_val > 0 else 150
                        extras_breakdown.append({"name": extra.title(), "price": f"${price}"})
                        total_spent += price
                        
                    remaining = budget_val - total_spent
                    
                    import random
                    attendees = random.randint(int(expected * 0.5), int(expected * 1.2))
                    
                    events_list.append({
                        "id": row[0],
                        "name": row[1],
                        "date": row[2],
                        "budget_total": f"${budget_val}",
                        "budget_remaining": f"${remaining}",
                        "extras": extras_breakdown,
                        "attendees": attendees,
                        "expected_attendees": expected
                    })
                
                self._set_headers()
                self.wfile.write(json.dumps({"events": events_list}).encode())
            except Exception as e:
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": str(e)}).encode())
            return
            
        return super().do_GET()

    def do_POST(self):
        content_length = int(self.headers.get('Content-Length', 0))
        post_data = self.rfile.read(content_length) if content_length > 0 else b''
        
        if self.path == '/api/chat':
            # Proxy chat to n8n
            try:
                data = json.loads(post_data.decode('utf-8'))
                
                # n8n Chat Trigger typically accepts {"action": "sendMessage", "sessionId": "...", "chatInput": "..."}
                req = urllib.request.Request(
                    f"{N8N_URL}/webhook/3af4c488-a56f-42f6-8ae8-3242d6e80b14", 
                    data=post_data,
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                res = urllib.request.urlopen(req)
                response_data = res.read()
                # print("n8n Webhook Response:", response_data.decode('utf-8', errors='ignore'))
                
                self._set_headers()
                self.wfile.write(response_data)
            except urllib.error.HTTPError as e:
                app_state["thought_process"].append(f"❌ Error communicating with Agent: HTTP {e.code}")
                self._set_headers(e.code)
                self.wfile.write(e.read())
            except Exception as e:
                app_state["thought_process"].append(f"❌ Fatal Error: {str(e)}")
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": str(e)}).encode())

        elif self.path == '/api/chat-phase2':
            # Proxy phase 2 chat to n8n
            try:
                data = json.loads(post_data.decode('utf-8'))
                
                event_data = app_state.get("event", {})
                extras_data = app_state.get("selected_extras", [])
                chat_input = data.get("chatInput", "")
                
                # Bundle the context directly into the chat message so n8n doesn't have to evaluate it
                data["chatInput"] = f"{chat_input}\n\n[SYSTEM CONTEXT: The user has selected the following extras: {json.dumps(extras_data)}. The event details are: {json.dumps(event_data)}]"
                
                # Inject event and selected extras into the payload (for legacy Extract Body 2)
                data["event"] = event_data
                data["selected_extras"] = extras_data
                
                req = urllib.request.Request(
                    f"{N8N_URL}/webhook/{PHASE2_WEBHOOK_ID}", 
                    data=json.dumps(data).encode('utf-8'),
                    headers={'Content-Type': 'application/json'},
                    method='POST'
                )
                res = urllib.request.urlopen(req)
                response_data = res.read()
                
                self._set_headers()
                self.wfile.write(response_data)
            except urllib.error.HTTPError as e:
                app_state["thought_process"].append(f"❌ Error in Phase 2: HTTP {e.code}")
                self._set_headers(e.code)
                self.wfile.write(e.read())
            except Exception as e:
                app_state["thought_process"].append(f"❌ Fatal Error in Phase 2: {str(e)}")
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        elif self.path == '/api/reset':
            app_state["status"] = "chatting"
            app_state["event"] = None
            app_state["extras_options"] = []
            app_state["selected_extras"] = []
            app_state["thought_process"] = []
            app_state["current_event_id"] = None
            
            self._set_headers()
            self.wfile.write(json.dumps({"success": True}).encode())

        elif self.path == '/api/submit-extras':
            try:
                data = json.loads(post_data.decode('utf-8'))
                selected_extras = data.get("selected_extras", [])
                
                # Reset state
                app_state["status"] = "phase2_chat"
                app_state["selected_extras"] = selected_extras
                
                # Update DB
                if app_state.get("current_event_id"):
                    conn = sqlite3.connect(DB_PATH)
                    c = conn.cursor()
                    c.execute('UPDATE events SET extras = ? WHERE id = ?',
                              (json.dumps(selected_extras), app_state["current_event_id"]))
                    conn.commit()
                    conn.close()
                
                self._set_headers()
                self.wfile.write(json.dumps({"success": True}).encode())
            except Exception as e:
                app_state["thought_process"].append(f"❌ Failed to submit extras: {str(e)}")
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": str(e)}).encode())

        elif self.path == '/':
            # n8n HTTP Request node posts here
            try:
                data = json.loads(post_data.decode('utf-8'))
                # print("Received from n8n:", data)
                
                if data.get("status") == "awaiting_selection":
                    app_state["status"] = "awaiting_selection"
                    event_data = data.get("event", {})
                    app_state["event"] = event_data
                    app_state["extras_options"] = data.get("extras_options", [])
                    
                    # Insert into DB
                    budget_str = str(event_data.get("budget", "0"))
                    import re
                    budget_nums = re.findall(r'\d+', budget_str.replace(',', ''))
                    budget_val = int(budget_nums[0]) if budget_nums else 0
                    
                    expected_str = str(event_data.get("expected_attendance", "50"))
                    expected_nums = re.findall(r'\d+', expected_str)
                    expected_val = int(expected_nums[0]) if expected_nums else 50
                    
                    conn = sqlite3.connect(DB_PATH)
                    c = conn.cursor()
                    c.execute('INSERT INTO events (name, date, budget, expected_attendance, raw_data) VALUES (?, ?, ?, ?, ?)',
                              (event_data.get("title", "My Event"),
                               event_data.get("date", "TBD"),
                               budget_val,
                               expected_val,
                               json.dumps(event_data)))
                    app_state["current_event_id"] = c.lastrowid
                    conn.commit()
                    conn.close()
                
                self._set_headers()
                self.wfile.write(json.dumps({"success": True}).encode())
            except Exception as e:
                print("Error processing n8n webhook:", e)
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": str(e)}).encode())
        elif self.path == '/api/mock-search':
            # Mock API Tool for the AI Agent
            try:
                data = json.loads(post_data.decode('utf-8'))
                query = data.get("query", "").lower()
                location = data.get("location", "unknown")
                budget = data.get("budget", "unknown")
                
                # Mock response based on query
                app_state["thought_process"].append(f"🔍 Agent is researching: '{query}'...")
                
                results = []
                possible_extras = ["venue", "rental", "food", "catering", "speaker", "dj", "photographer", "decorations", "lighting"]
                
                for extra in possible_extras:
                    if extra in query:
                        # Base mock prices that vary slightly based on the extra type
                        base_price = 1000 if extra in ["venue", "rental"] else (300 if extra in ["dj", "photographer"] else 500)
                        
                        results.append({
                            "service_type": extra.title(),
                            "name": f"Premium {extra.title()} in {location}", 
                            "price": f"${base_price + 200}", 
                            "description": f"High-end {extra} service matching the selected criteria."
                        })
                        results.append({
                            "service_type": extra.title(),
                            "name": f"Budget {extra.title()} in {location}", 
                            "price": f"${int(base_price / 2)}", 
                            "description": f"Affordable {extra} service."
                        })
                        
                if not results:
                    results = [
                        {"name": f"Generic Service in {location}", "price": "Varies based on budget", "description": f"Matches your query: {query}"}
                    ]
                    
                response = {
                    "results": results,
                    "context_provided": {"location": location, "budget": budget}
                }
                self._set_headers()
                self.wfile.write(json.dumps(response).encode())
            except Exception as e:
                app_state["thought_process"].append(f"❌ Mock Search Error: {str(e)}")
                self._set_headers(500)
                self.wfile.write(json.dumps({"error": str(e)}).encode())

        else:
            self._set_headers(404)
            self.wfile.write(b'{"error": "Not found"}')

class ThreadedTCPServer(socketserver.ThreadingMixIn, socketserver.TCPServer):
    allow_reuse_address = True

# Serve from frontend dir
os.chdir(os.path.join(os.path.dirname(os.path.abspath(__file__)), '../frontend'))

init_db()

with ThreadedTCPServer(("", PORT), CustomHandler) as httpd:
    print(f"Serving at http://localhost:{PORT} with multi-threading")
    httpd.serve_forever()
