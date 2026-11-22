# MentorLagbe Backend Server (Express + MongoDB + Stripe)

This repository contains the backend REST API server for the **MentorLagbe** tutoring and mentorship platform.

---

## 🛠️ Technologies Used

- **Runtime**: Node.js
- **Framework**: Express.js (v5)
- **Database**: MongoDB (Atlas)
- **Authentication**: JWT & BetterAuth integration
- **Payment Processing**: Stripe Checkout & Webhooks
- **Middleware**: CORS, Dotenv

---

## 🚀 Getting Started

### 1. Prerequisites

- Node.js (v18 or higher recommended)
- MongoDB Connection String
- Stripe API Keys

### 2. Environment Variables (.env)

Create a `.env` file in the root of `mentor_lagbe_server` with the following variables:

### 3. Installation

```bash
npm install
```

### 4. Running the Server

```bash
# Development (with auto-reload via nodemon)
npm run dev

# Production
npm start
```

The server will start at `http://localhost:5000`.

---

## 📡 API Endpoints

### Health Check

- `GET /` — Server status and connectivity check.

### Tuitions

- `GET /api/tuitions` — Browse approved & active tuitions. Supports query filters: `search`, `subject`, `classLevel`, `mode`, `tutorEmail`, and `all=true` (admin).
- `GET /api/tuitions/:id` — Get single tuition listing details.
- `POST /api/tuitions` — Create a new tuition listing (Requires `tutor` role). Enforces free plan limit (max 2 posts) vs unlimited pro plan.
- `PATCH /api/tuitions/:id` — Update listing details or toggle active/closed status (`{ action: "toggle-active" }`).
- `DELETE /api/tuitions/:id` — Delete a tuition post and all associated applications.

### Applications

- `GET /api/applications` — Fetch applications filtered by `studentEmail`, `tutorEmail`, or `tuitionId`.
- `POST /api/applications` — Submit a new application for an approved tuition (Requires `student` role; prevents duplicate submissions).
- `PATCH /api/applications` — Tutor accepts or rejects an application (`{ id, action: "accept" | "reject" }`).
- `DELETE /api/applications` — Student cancels a pending application (`{ id }`).

### Admin Management

- `GET /api/admin/users` — List all registered users (Requires `admin` role).
- `POST /api/admin/users` — Update a user's role (`student`, `tutor`, `admin`).
- `GET /api/admin/tuitions` — List all tuitions for admin approval review.
- `POST /api/admin/tuitions` — Approve or reject a tuition listing (`{ id, action: "approve" | "reject" }`).
- `GET /api/admin/transactions` — View all Stripe payment transaction records.
- `GET /api/admin/stats` — Dashboard statistics (Total Users, Tutors, Students, Pending/Approved Tuitions, Total Revenue).

### Dashboard Statistics

- `GET /api/stats/student` — Overview statistics for student dashboard.
- `GET /api/stats/tutor` — Overview statistics for tutor dashboard.

### Stripe Payments

- `POST /api/checkout` — Create a Stripe Checkout session for Student Pro ($10) or Tutor Pro ($15) in `payment` mode.
- `POST /api/checkout/verify` — Confirm payment session upon return, upgrade user plan to `pro`, and record payment.
- `POST /api/webhook/stripe` — Stripe webhook receiver for `checkout.session.completed` events.

### Authentication Helpers

- `POST /api/auth/quick-login` — Helper endpoint to prepare quick-access credentials for Admin, Tutor, and Student accounts.
- `PATCH /api/users/profile` — Update user profile details (Name, Phone, Bio, Image).
