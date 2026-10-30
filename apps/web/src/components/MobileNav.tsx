'use client';

import React from 'react';
import { BookOpen, LayoutDashboard, Search, Zap } from 'lucide-react';
import type { View } from './Sidebar';

interface MobileNavProps {
  activeView: View;
  onNavigate: (view: View) => void;
}

const items: Array<{ id: View; label: string; icon: React.ReactNode }> = [
  { id: 'dashboard', label: 'Home', icon: <LayoutDashboard className="h-4 w-4" /> },
  { id: 'skills', label: 'Skills', icon: <BookOpen className="h-4 w-4" /> },
  { id: 'research', label: 'Research', icon: <Search className="h-4 w-4" /> },
];

export function MobileNav({ activeView, onNavigate }: MobileNavProps) {
  return (
    <div className="lg:hidden sticky top-0 z-20 border-b border-zinc-800 bg-[#0a0a0a]/95 backdrop-blur">
      <div className="flex items-center justify-between px-4 py-3">
        <div className="flex items-center gap-2">
          <div className="h-7 w-7 rounded-lg bg-white text-black grid place-items-center">
            <Zap className="h-3.5 w-3.5" />
          </div>
          <span className="text-sm font-semibold text-white">GHOST</span>
        </div>
        <nav className="flex items-center gap-1">
          {items.map((item) => (
            <button
              key={item.id}
              onClick={() => onNavigate(item.id)}
              className={`px-2.5 py-1.5 rounded-lg text-xs flex items-center gap-1.5 ${
                activeView === item.id ? 'bg-zinc-800 text-white' : 'text-zinc-400'
              }`}
            >
              {item.icon}
              {item.label}
            </button>
          ))}
        </nav>
      </div>
    </div>
  );
}
