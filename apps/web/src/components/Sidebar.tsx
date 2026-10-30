'use client';

import React from 'react';
import { Activity, BookOpen, LayoutDashboard, Search, ShieldCheck, Zap } from 'lucide-react';

export type View = 'dashboard' | 'skills' | 'research';

interface SidebarProps {
  activeView: View;
  onNavigate: (view: View) => void;
  modelConnected: boolean;
  modelLabel: string;
}

const navItems: Array<{ id: View; label: string; icon: React.ReactNode }> = [
  { id: 'dashboard', label: 'Dashboard', icon: <LayoutDashboard className="h-4 w-4" /> },
  { id: 'skills', label: 'Skills', icon: <BookOpen className="h-4 w-4" /> },
  { id: 'research', label: 'Research', icon: <Search className="h-4 w-4" /> },
];

export function Sidebar({ activeView, onNavigate, modelConnected, modelLabel }: SidebarProps) {
  return (
    <aside className="hidden lg:flex w-64 shrink-0 flex-col border-r border-zinc-800 bg-[#0c0c0c] min-h-screen sticky top-0">
      <div className="p-6">
        <div className="flex items-center gap-2">
          <div className="h-8 w-8 rounded-lg bg-white text-black grid place-items-center">
            <Zap className="h-4 w-4" />
          </div>
          <div>
            <h1 className="text-base font-semibold tracking-tight text-white leading-none">GHOST</h1>
            <p className="text-[10px] text-zinc-500 mt-1">Local browser agent</p>
          </div>
        </div>
      </div>

      <nav className="px-3 space-y-1">
        {navItems.map((item) => (
          <button
            key={item.id}
            onClick={() => onNavigate(item.id)}
            className={`w-full flex items-center gap-3 px-3 py-2 rounded-xl text-sm transition-colors ${
              activeView === item.id
                ? 'bg-zinc-800 text-white'
                : 'text-zinc-400 hover:text-zinc-200 hover:bg-zinc-900'
            }`}
          >
            {item.icon}
            {item.label}
          </button>
        ))}
      </nav>

      <div className="mt-auto p-4 border-t border-zinc-800">
        <div className="rounded-xl bg-[#111111] border border-zinc-800 p-3">
          <div className="flex items-center gap-2 text-xs">
            <Activity className={`h-3.5 w-3.5 ${modelConnected ? 'text-green-400' : 'text-amber-400'}`} />
            <span className={modelConnected ? 'text-green-300' : 'text-amber-300'}>
              {modelConnected ? 'Model connected' : 'Model unavailable'}
            </span>
          </div>
          <p className="text-[10px] text-zinc-500 mt-1 truncate" title={modelLabel}>
            {modelLabel}
          </p>
        </div>
        <div className="flex items-center gap-2 mt-3 px-1 text-[10px] text-zinc-600">
          <ShieldCheck className="h-3 w-3" />
          Policy-gated execution
        </div>
      </div>
    </aside>
  );
}
