'use client';

import { useEffect } from 'react';
import { watchChatGptSubscription } from '../../lib/chatgpt-subscription-client';

export function ChatGptSubscriptionBridge() {
  useEffect(watchChatGptSubscription, []);
  return null;
}
