document.addEventListener('DOMContentLoaded', () => {
    // Elements
    const chatSection = document.getElementById('chat-section');
    const extrasSection = document.getElementById('extras-section');
    const warRoomSection = document.getElementById('war-room-section');
    
    const chatMessages = document.getElementById('chat-messages');
    const chatForm = document.getElementById('chat-form');
    const chatInput = document.getElementById('chat-input');
    const typingIndicator = document.getElementById('typing-indicator');
    
    const extrasGrid = document.getElementById('extras-grid');
    const extrasForm = document.getElementById('extras-form');
    const eventTitleDisplay = document.getElementById('event-title-display');

    // State
    const sessionId = 'session_' + Math.random().toString(36).substr(2, 9);
    let pollingInterval = null;
    let currentPhase = 1;

    // ----- CHAT LOGIC -----

    function addMessage(text, sender) {
        const div = document.createElement('div');
        div.className = `message ${sender}`;
        div.innerHTML = `<div class="message-bubble">${text.replace(/\n/g, '<br>')}</div>`;
        chatMessages.appendChild(div);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function showTyping() {
        typingIndicator.style.display = 'flex';
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function hideTyping() {
        typingIndicator.style.display = 'none';
    }

    chatForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const text = chatInput.value.trim();
        if (!text) return;

        addMessage(text, 'user');
        chatInput.value = '';
        showTyping();

        try {
            // Send to our backend proxy depending on phase
            const endpoint = currentPhase === 1 ? '/api/chat' : '/api/chat-phase2';
            const response = await fetch(endpoint, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: "sendMessage",
                    sessionId: sessionId,
                    chatInput: text
                })
            });
            
            const data = await response.json();
            hideTyping();
            
            // Render bot response
            if (data.output) {
                if (data.output.includes("[[DASHBOARD_READY]]")) {
                    transitionToCompleted();
                } else if (!data.output.includes("EVENT_COMPLETE")) {
                    addMessage(data.output.replace("[[DASHBOARD_READY]]", "").trim(), 'bot');
                }
            } else if (Array.isArray(data) && data.length > 0 && data[0].output) {
                if (data[0].output.includes("[[DASHBOARD_READY]]")) {
                    transitionToCompleted();
                } else if (!data[0].output.includes("EVENT_COMPLETE")) {
                    addMessage(data[0].output.replace("[[DASHBOARD_READY]]", "").trim(), 'bot');
                }
            } else {
                addMessage("I processed that, but received an unexpected response.", 'bot');
            }
        } catch (error) {
            console.error('Chat error:', error);
            hideTyping();
            addMessage("Sorry, I'm having trouble connecting to the server.", 'bot');
        }
    });

    // ----- POLLING FOR STATE CHANGES -----
    
    function startPolling() {
        pollingInterval = setInterval(async () => {
            try {
                const res = await fetch('/api/status');
                const data = await res.json();
                
                // Thought process rendering removed as per request
                
                if (data.status === 'awaiting_selection' && chatSection.classList.contains('active-view')) {
                    transitionToExtras(data);
                } else if (data.status === 'phase2_chat' && currentPhase === 1) {
                    transitionToPhase2Chat();
                } else if (data.status === 'completed' && !completedSection.classList.contains('active-view')) {
                    transitionToCompleted();
                }
            } catch (err) {
                console.error("Polling error:", err);
            }
        }, 2000);
    }

    // ----- VIEW TRANSITIONS -----

    function transitionToExtras(data) {
        // Set Title
        if (data.event && data.event.title) {
            eventTitleDisplay.textContent = data.event.title;
        }

        // Generate Grid
        extrasGrid.innerHTML = '';
        if (data.extras_options && data.extras_options.length > 0) {
            data.extras_options.forEach(opt => {
                const card = document.createElement('div');
                card.className = 'extra-card';
                card.innerHTML = `
                    <div class="extra-icon">${opt.icon}</div>
                    <div class="extra-label">${opt.label}</div>
                    <input type="checkbox" class="checkbox-hidden" name="extras" value="${opt.id}">
                `;
                
                // Toggle selection
                card.addEventListener('click', () => {
                    const checkbox = card.querySelector('input');
                    checkbox.checked = !checkbox.checked;
                    if (checkbox.checked) {
                        card.classList.add('selected');
                    } else {
                        card.classList.remove('selected');
                    }
                });
                
                extrasGrid.appendChild(card);
            });
        }

        // Switch Views
        chatSection.classList.remove('active-view');
        chatSection.classList.add('hidden-view');
        extrasSection.classList.remove('hidden-view');
        extrasSection.classList.add('active-view');
    }

    async function transitionToPhase2Chat() {
        currentPhase = 2;
        
        // Switch back to chat view
        extrasSection.classList.remove('active-view');
        extrasSection.classList.add('hidden-view');
        chatSection.classList.remove('hidden-view');
        chatSection.classList.add('active-view');
        
        addMessage("Fetching availability and pricing for your selected extras...", 'system');
        showTyping();
        
        // Auto-initiate phase 2 chat to trigger agent
        try {
            const response = await fetch('/api/chat-phase2', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action: "initPhase2",
                    sessionId: sessionId,
                    chatInput: "I have selected my extras. Please review them based on my location and budget."
                })
            });
            const data = await response.json();
            hideTyping();
            
            if (data.output) {
                if (data.output.includes("[[DASHBOARD_READY]]")) {
                    transitionToCompleted();
                } else {
                    addMessage(data.output.replace("[[DASHBOARD_READY]]", "").trim(), 'bot');
                }
            } else if (Array.isArray(data) && data.length > 0 && data[0].output) {
                if (data[0].output.includes("[[DASHBOARD_READY]]")) {
                    transitionToCompleted();
                } else {
                    addMessage(data[0].output.replace("[[DASHBOARD_READY]]", "").trim(), 'bot');
                }
            }
            
            // Hide thought process once the agent has fully responded
            document.getElementById('thought-process-container').style.display = 'none';
        } catch (err) {
            hideTyping();
            addMessage("Failed to connect to the Extras Planner.", 'bot');
        }
    }

    let allEvents = [];

    window.toggleDashboard = function(show) {
        if (show) {
            chatSection.classList.remove('active-view');
            chatSection.classList.add('hidden-view');
            extrasSection.classList.remove('active-view');
            extrasSection.classList.add('hidden-view');
            warRoomSection.classList.remove('hidden-view');
            warRoomSection.classList.add('active-view');
            loadDashboardData();
        } else {
            warRoomSection.classList.remove('active-view');
            warRoomSection.classList.add('hidden-view');
            extrasSection.classList.remove('active-view');
            extrasSection.classList.add('hidden-view');
            chatSection.classList.remove('hidden-view');
            chatSection.classList.add('active-view');
        }
    };
    
    window.resetApp = async function() {
        try {
            await fetch('/api/reset', { method: 'POST' });
        } catch (e) {
            console.error('Failed to reset backend state', e);
        }
        location.reload();
    };

    async function transitionToCompleted() {
        if (pollingInterval) clearInterval(pollingInterval);
        window.toggleDashboard(true);
    }
    
    async function loadDashboardData() {
        try {
            const res = await fetch('/api/dashboard');
            const data = await res.json();
            
            if (data.error) throw new Error(data.error);
            if (!data.events || data.events.length === 0) {
                document.getElementById('dash-event-name').textContent = "No Events Found";
                return;
            }
            
            allEvents = data.events;
            
            // Populate select
            const selector = document.getElementById('event-selector');
            selector.innerHTML = '';
            allEvents.forEach((ev, index) => {
                const opt = document.createElement('option');
                opt.value = index;
                opt.textContent = ev.name;
                selector.appendChild(opt);
            });
            
            // Load the most recent event (first one)
            renderEventData(allEvents[0]);
            
            selector.addEventListener('change', (e) => {
                const idx = e.target.value;
                if (allEvents[idx]) {
                    renderEventData(allEvents[idx]);
                }
            });
            
        } catch (err) {
            console.error('Failed to load dashboard data:', err);
            document.getElementById('dash-event-name').textContent = "Error Loading Data";
        }
    }
    
    function renderEventData(data) {
            
            // Populate basic info
            document.getElementById('dash-event-name').textContent = data.name;
            document.getElementById('dash-event-date').textContent = data.date;
            
            // Calculate countdown
            const eventDate = new Date(data.date);
            if (!isNaN(eventDate)) {
                const today = new Date();
                const diffTime = eventDate - today;
                const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));
                if (diffDays >= 0) {
                    document.getElementById('dash-countdown').textContent = `${diffDays} days remaining`;
                } else {
                    document.getElementById('dash-countdown').textContent = "Event passed";
                }
            } else {
                document.getElementById('dash-countdown').textContent = "Date TBD";
            }
            
            // Attendees
            document.getElementById('dash-attendees').textContent = data.attendees;
            document.getElementById('dash-expected').textContent = data.expected_attendees;
            
            const progress = Math.min((data.attendees / data.expected_attendees) * 100, 100);
            setTimeout(() => {
                document.getElementById('dash-progress').style.width = `${progress}%`;
            }, 500);
            
            // Budget
            document.getElementById('dash-budget-total').textContent = data.budget_total;
            document.getElementById('dash-budget-remaining').textContent = data.budget_remaining;
            
            // Parse remaining to see if negative
            const remainingVal = parseInt(data.budget_remaining.replace(/[^\d.-]/g, ''));
            if (remainingVal < 0) {
                document.getElementById('dash-budget-remaining').style.color = '#ef4444'; // Red if over budget
            }
            
            // Extras
            const extrasList = document.getElementById('dash-extras-list');
            extrasList.innerHTML = '';
            
            
            if (data.extras && data.extras.length > 0) {
                data.extras.forEach(extra => {
                    extrasList.innerHTML += `
                        <li>
                            <span class="extra-name">${extra.name}</span>
                            <span class="extra-price dash-highlight" style="font-size: 1rem;">${extra.price}</span>
                        </li>
                    `;
                });
            } else {
                extrasList.innerHTML = `<li><span style="color: #a0aec0;">No extras selected.</span></li>`;
            }
    }

    // ----- SUBMIT EXTRAS -----

    extrasForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const submitBtn = document.getElementById('submit-extras-btn');
        submitBtn.textContent = 'Processing...';
        submitBtn.disabled = true;

        const checkboxes = document.querySelectorAll('input[name="extras"]:checked');
        const selected_extras = Array.from(checkboxes).map(cb => cb.value);

        try {
            await fetch('/api/submit-extras', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ selected_extras })
            });
            // Let polling handle the transition to phase2_chat
        } catch (err) {
            console.error('Error submitting extras:', err);
            submitBtn.textContent = 'Error - Try Again';
            submitBtn.disabled = false;
        }
    });

    // Start polling on load
    startPolling();
});
