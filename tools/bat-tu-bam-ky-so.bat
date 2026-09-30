@echo off
rem HaTools - bam dup file nay de bat cong cu tu bam "Ky so" truoc khi chay me so hoa.
rem Cua so se tu dong tat sau 5 phut khong thay cua so ky nao.
title HaTools - tu bam Ky so
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0auto-ky-so.ps1" -IdleMinutes 5
