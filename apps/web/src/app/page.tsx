'use client';

import React, { useState, useEffect } from 'react';
import { Play, CheckCircle2, XCircle, Loader2, Clock, Image as ImageIcon } from 'lucide-react';

interface TaskEvent {
  type: string;
  timestamp: number;
  data: Record<string, unknown>;
}

interface Task {
  id: string;
  objective: string;
  status: string;
  currentStepIndex: number;
  lastEventId: string | null;
}

export default function Dashboard() {
  const [task, setTask] = useState<Task | null>(null);
  const [events, setEvents] = useState<TaskEvent[]>([]);
  const [screenshotUrl, setScreenshotUrl] = useState<string | null>(null);
  const [isPolling, setIsPolling] = useState(false);

  const startTask = async () => {
    setTask(null);
    setEvents([]);
    setScreenshotUrl(null);

    try {
      const res = await fetch('http://localhost:3002/tasks/start', { method: 'POST' });
      const data = await res.json();
      const taskId = data.taskId;

      setTask({
        id: taskId,
        objective: 'Demo vertical slice: Navigate and capture screenshot',
        status: 'IDLE',
        currentStepIndex: 0,
        lastEventId: null
      });

      startPolling(taskId);
    } catch (err) {
      console.error('Failed to start task', err);
    }
  };

  const startPolling = (taskId: string) => {
    setIsPolling(true);
    const interval = setInterval(async () => {
      try {
        // Fetch task status
        const taskRes = await fetch(`http://localhost:3002/tasks/${taskId}`);
        const updatedTask = await taskRes.json();
        setTask(updatedTask);

        // Fetch events
        const eventsRes = await fetch(`http://localhost:3002/tasks/${taskId}/events`);
        const updatedEvents = await eventsRes.json();
        setEvents(updatedEvents);

        if (updatedTask.status === 'COMPLETED' || updatedTask.status === 'FAILED') {
          // Check for screenshot
          const screenshotRes = await fetch(`http://localhost:3002/tasks/${taskId}/screenshot-url`);
          const screenshotData = await screenshotRes.json();
          if (screenshotData.url) {
            setScreenshotUrl(screenshotData.url);
          }
          clearInterval(interval);
          setIsPolling(false);
        }
      } catch (err) {
        console.error('Polling error', err);
        clearInterval(interval);
        setIsPolling(false);
      }
    }, 1000);
  };

  return (
    <div className="min-h-screen bg-[#0a0a0a] text-[#ededed] font-sans p-8">
      <header className="max-w-5xl mx-auto flex justify-between items-center mb-12">
        <div>
          <h1 className="text-4xl font-bold tracking-tighter text-white">GHOST</h1>
          <p className="text-zinc-500">System Status: <span className="text-green-500">Ready</span></p>
        </div>
        <button
          onClick={startTask}
          disabled={isPolling}
          className="bg-white text-black px-6 py-2 rounded-full font-medium hover:bg-zinc-200 disabled:opacity-50 transition-colors flex items-center gap-2"
        >
          {isPolling ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />}
          Start Demo Task
        </button>
      </header>

      <main className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-8">
        {/* Stats & Status */}
        <div className="space-y-6">
          <div className="bg-[#161616] border border-zinc-800 p-6 rounded-2xl">
            <h2 className="text-zinc-500 text-sm mb-2">Current Status</h2>
            <div className="flex items-center gap-3">
              <span className={`px-3 py-1 rounded-full text-xs font-medium ${
                task?.status === 'COMPLETED' ? 'bg-green-500/10 text-green-500' :
                task?.status === 'FAILED' ? 'bg-red-500/10 text-red-500' :
                'bg-blue-500/10 text-blue-500'
              }`}>
                {task?.status || 'IDLE'}
              </span>
              <span className="text-xl font-semibold">{task?.status || 'IDLE'}</span>
            </div>
          </div>

          <div className="bg-[#161616] border border-zinc-800 p-6 rounded-2xl">
            <h2 className="text-zinc-500 text-sm mb-4">Timeline</h2>
            <div className="space-y-4">
              {events.length === 0 && <p className="text-zinc-600 text-sm">No events recorded yet.</p>}
              {events.map((event, idx) => (
                <div key={idx} className="flex gap-3 text-sm">
                  <div className="w-2 h-2 rounded-full bg-zinc-700 mt-1.5 shrink-0" />
                  <div>
                    <p className="text-zinc-300 capitalize">{event.type.replace('_', ' ')}</p>
                    <p className="text-zinc-600 text-[10px]">{new Date(event.timestamp).toLocaleTimeString()}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>

        {/* Main View: Screenshot or Empty */}
        <div className="md:col-span-2 bg-[#161616] border border-zinc-800 rounded-2xl overflow-hidden relative min-h-[400px] flex items-center justify-center">
          {screenshotUrl ? (
            <div className="w-full h-full flex flex-col">
              <div className="p-4 border-b border-zinc-800 flex items-center gap-2 text-sm text-zinc-400">
                <ImageIcon className="w-4 h-4" />
                <span>Evidence: full-page.png</span>
              </div>
              <img src={screenshotUrl} alt="Task evidence" className="w-full h-auto object-contain" />
            </div>
          ) : task?.status === 'EXECUTING' || task?.status === 'VERIFYING' ? (
            <div className="flex flex-col items-center gap-4">
              <Loader2 className="w-10 h-10 animate-spin text-blue-500" />
              <p className="text-zinc-500">Processing Task...</p>
            </div>
          ) : (
            <div className="text-zinc-600 flex flex-col items-center gap-2">
              <div className="w-16 h-16 rounded-full border-2 border-dashed border-zinc-800 flex items-center justify-center">
                <ImageIcon className="w-6 h-6" />
              </div>
              <p>No visual evidence captured</p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
}
