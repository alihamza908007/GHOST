import React from 'react';

type BadgeProps = React.HTMLAttributes<HTMLSpanElement> & {
  tone?: 'neutral' | 'blue' | 'green' | 'red' | 'amber';
};

const tones = {
  neutral: 'bg-zinc-500/10 text-zinc-400 border-zinc-500/20',
  blue: 'bg-blue-500/10 text-blue-300 border-blue-500/20',
  green: 'bg-green-500/10 text-green-300 border-green-500/20',
  red: 'bg-red-500/10 text-red-300 border-red-500/20',
  amber: 'bg-amber-500/10 text-amber-300 border-amber-500/20',
};

export function Badge({ children, tone = 'neutral', className = '', ...props }: BadgeProps) {
  return (
    <span
      {...props}
      className={`inline-flex items-center px-2 py-0.5 rounded-full border text-[10px] font-medium uppercase tracking-wide ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}
