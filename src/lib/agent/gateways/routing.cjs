'use strict';

/** Shared by the desktop dispatcher, gateway tools, and configuration UI. */
function selectChannelProfile(config, platform = '', profileId = '') {
  const profiles = Array.isArray(config?.profiles) ? config.profiles : [];
  const channel = String(platform || '').trim().toLowerCase();
  const allows = profile => !channel || !profile.channels?.length || profile.channels.includes(channel);
  if (profileId) return profiles.find(profile => profile.id === profileId && allows(profile)) || null;
  return (channel && profiles.find(profile => profile.channels?.includes(channel)))
    || profiles.find(profile => profile.id === config?.defaultProfileId && allows(profile))
    || profiles.find(profile => allows(profile))
    || null;
}

function canDispatchChannel(config, event) {
  if (!config?.enabled || !config.autoDispatch || !config.channelAgent?.enabled || !config.platforms?.[event?.platform]?.enabled) return false;
  const profile = selectChannelProfile(config.channelAgent, event.platform);
  return Boolean(profile && ['assist', 'autonomous'].includes(profile.operatingMode));
}

module.exports = { selectChannelProfile, canDispatchChannel };
