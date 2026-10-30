import React from 'react';

type CardProps = React.HTMLAttributes<HTMLDivElement> & {
  header?: React.ReactNode;
  footer?: React.ReactNode;
  padding?: 'none' | 'sm' | 'md';
};

export function Card({ children, header, footer, className = '', padding = 'md', ...props }: CardProps) {
  return (
    <div
      {...props}
      className={`bg-[#121212] border border-zinc-800 rounded-2xl overflow-hidden ${className}`}
    >
      {header && <div className="px-5 py-4 border-b border-zinc-800">{header}</div>}
      <div className={padding === 'none' ? '' : padding === 'sm' ? 'p-3' : 'p-5'}>{children}</div>
      {footer && <div className="px-5 py-4 border-t border-zinc-800 bg-[#0d0d0d]">{footer}</div>}
    </div>
  );
}
