import { EmbedBuilder, Colors } from 'discord.js';

export const brand = (e) => e.setColor(Colors.Gold).setTimestamp();

export const infoEmbed = (title, desc) =>
  brand(new EmbedBuilder().setTitle(title).setDescription(desc));

export const errorEmbed = (msg) =>
  new EmbedBuilder().setColor(Colors.Red).setTitle('⛔ Error').setDescription(msg);

export const successEmbed = (msg) =>
  new EmbedBuilder().setColor(Colors.Green).setTitle('✅ Success').setDescription(msg);

export const eph = (payload) => ({ ...payload, ephemeral: true });
