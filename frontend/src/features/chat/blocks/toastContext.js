import { createContext, useContext } from 'react';

export const ToastContext = createContext(() => {});

/** notify({ text, tone: 'positive' | 'negative' | 'info' }) */
export const useToast = () => useContext(ToastContext);
