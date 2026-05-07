# CloudShare

A cloud-native multimedia storage platform built on Microsoft Azure.
Final submission for **COM682 Cloud Native Development - CW2**.

**Author**: Subeg Poudal (B00970131)
**Module**: COM682 Cloud Native Development
**University**: Ulster University (QAHE)

---

## Overview

CloudShare is an iCloud-style multimedia storage application that lets users sign up, upload, organize, and manage their files in the cloud. Files are categorized into Drive, Notes, and Photos. The entire stack is deployed on Microsoft Azure using cloud-native services.

## Live Demo

- **Frontend**: https://cloudshareblobsubeg.z43.web.core.windows.net/login.html
- **API Health**: https://cloudshare-api-subeg-eucyg3bne8hnh8bk.spaincentral-01.azurewebsites.net/api/health

## Architecture

| Layer | Service | Purpose |
|---|---|---|
| Frontend | Azure Storage Static Website | Hosts HTML/CSS/JS |
| Backend | Azure Functions (Flex Consumption) | Serverless Express.js API |
| User auth | Azure SQL Database (Hyperscale) | Users + bcrypt password hashes |
| Metadata | Azure Cosmos DB (NoSQL) | File metadata, queryable by user |
| File storage | Azure Blob Storage | Binary file content |
| Monitoring | Application Insights | Real-time telemetry |
| Workflow | Azure Logic Apps | Event-driven blob upload trigger |
| CI/CD | GitHub Actions | Auto-deploy on push to main |

## Tech Stack

- Node.js, Express, JWT, bcrypt
- Vanilla HTML/CSS/JS (no framework)
- Microsoft Azure
- GitHub Actions

## Features

- Email + password signup with input validation
- JWT-based authentication
- File upload up to 50 MB with drag-and-drop
- Auto-categorization (Drive / Notes / Photos)
- Per-user file isolation
- File rename and delete
- Storage usage tracking
- Real-time monitoring via Application Insights
- Continuous deployment via GitHub Actions

## REST API Endpoints

| Method | Endpoint | Description | Auth |
|---|---|---|---|
| GET | /api/health | Service health check | No |
| POST | /api/signup | Create user account | No |
| POST | /api/login | Authenticate, get JWT | No |
| GET | /api/media | List user's files | Yes |
| GET | /api/stats | Storage statistics | Yes |
| POST | /api/upload | Upload a file | Yes |
| PUT | /api/media/:id | Rename a file | Yes |
| DELETE | /api/media/:id | Delete a file | Yes |

## Cloud-Native Principles Applied

- Decoupled storage and compute
- Serverless auto-scaling via Flex Consumption
- Pay-per-request pricing
- Continuous deployment via GitHub Actions
- Event-driven workflows via Logic Apps
- Real-time observability via Application Insights

## Submission

This repository accompanies the 5-minute video walkthrough submitted via Panopto on Blackboard.