'use client';

import { useEffect } from 'react';
import { watchChatGptSubscription } from '../../lib/chatgpt-subscription-client';
import { watchAntigravity } from '../../lib/antigravity-client';
import { watchNativeProviders } from '../../lib/native-provider-client';

export function SubscriptionBridge() {
  useEffect(watchChatGptSubscription, []);
  useEffect(watchAntigravity, []);
  useEffect(watchNativeProviders, []);
  return null;
}
